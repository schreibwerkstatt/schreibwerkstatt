'use strict';
// Phase 1, Cloud-/Lokal-Multi-Pass: Kapitel → Chunks mit Delta-Cache, Basis-Extraktion
// (Cloud: Extraktions-Tier, Halbierungs-Retry bei Truncation) und additiver Gap-Pass.
// Facade: ../extraktion.js (runPhase1 wählt Single- oder Multi-Pass).
const { loadChapterExtractCache, saveChapterExtractCache, getBookSettings } = require('../../../../../db/schema');
const { i18nError, settledAll, retryOnTransientAi, updateJob, toSystemBlocks, halveChunkPages, pageSigSuffix } = require('../../../shared');
const { buildChapterSystemBlockText, bookSettingsSigPart, extractField } = require('../../utils');
const { _normalizeName } = require('../../figuren-merge');
const appSettings = require('../../../../../lib/app-settings');
const { getContextConfigFor, providerClass } = require('../../../../../lib/ai');

/**
 * Cloud-Multi-Pass: System-Blöcke eines Chunk-Calls. Läuft danach ein Gap-Pass
 * (completeness_passes > 0), steht der Kapiteltext als vorderster 1h-Block im System —
 * Basis- und Gap-Pass teilen den Präfix (gleiches Tier, kein Schema, siehe ../call.js),
 * die Gap-Runden lesen den Kapiteltext für ~0.1× statt ihn voll neu zu bezahlen. Ohne
 * Gap-Pass gäbe es keinen zweiten Leser: der 1h-Write (2×) wäre teurer als der Text im
 * User-Turn (1×) — dann bleibt er dort. Gibt `{ system, chText }` für den Prompt-Builder.
 */
function _chunkCallParts(ctx, chunk, chText, systemBlocks) {
  if (!((ctx.completenessPasses || 0) > 0)) return { system: systemBlocks, chText };
  return {
    system: [
      { text: buildChapterSystemBlockText(ctx.bookName, chunk.name, chunk.pages.length, chText), ttl: '1h', sharedPrefix: true },
      ...toSystemBlocks(systemBlocks, '1h'),
    ],
    chText: null,
  };
}

// Figuren-IDs eines Extraktions-Outputs gelten nur in DIESEM Output: jeder Call beginnt
// laut Prompt bei fig_1. Hängt man einen zweiten Output (Gap-Runde, zweite Hälfte des
// Halbierungs-Retry) an einen Chunk-Eintrag, teilen sich zwei Figuren eine id, und
// annotateBeziehungenNames bindet die Beziehungs-Ziele an den falschen Namen. Darum
// bekommt jede Beziehung VOR dem Anhängen den Namen ihres Ziels aus dem eigenen Output,
// und die angehängten Figuren werden über das Maximum des Bestands hinaus neu nummeriert.
function _annotateOwnNames(figuren) {
  const nameById = new Map();
  for (const f of (figuren || [])) if (f?.id != null && f.name) nameById.set(String(f.id), f.name);
  for (const f of (figuren || [])) {
    for (const bz of (f?.beziehungen || [])) {
      if (!bz || bz.name) continue;
      const nm = nameById.get(String(bz.figur_id ?? ''));
      if (nm) bz.name = nm;
    }
  }
}
function _maxFigIdx(figuren) {
  let max = 0;
  for (const f of (figuren || [])) { const m = /^fig_(\d+)$/.exec(f?.id || ''); if (m) max = Math.max(max, +m[1]); }
  return max;
}
/** Hängt `added` an `base` an: beide Seiten mit eigenen Zielnamen annotieren, `added`
 *  kollisionsfrei neu nummerieren (auch die Beziehungs-Ziele innerhalb von `added`). */
function appendFigurenKollisionsfrei(base, added) {
  _annotateOwnNames(base);
  _annotateOwnNames(added);
  let next = _maxFigIdx(base);
  const remap = new Map();
  for (const f of (added || [])) {
    const nid = 'fig_' + (++next);
    if (f.id != null) remap.set(String(f.id), nid);
    f.id = nid;
  }
  for (const f of (added || [])) {
    for (const bz of (f?.beziehungen || [])) {
      if (bz && remap.has(String(bz.figur_id ?? ''))) bz.figur_id = remap.get(String(bz.figur_id));
    }
  }
  base.push(...(added || []));
  return base;
}

/** Vereinigt die Array-Felder zweier Extraktions-Resultate (Halbierungs-Retry). */
function _concatExtractResults(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const va = a?.[k], vb = b?.[k];
    if (k === 'figuren') { out[k] = appendFigurenKollisionsfrei([...(va || [])], [...(vb || [])]); continue; }
    out[k] = (Array.isArray(va) || Array.isArray(vb)) ? [...(va || []), ...(vb || [])] : (va ?? vb);
  }
  return out;
}

// Pflichtfelder einer Chunk-Extraktion: fehlt eines, ist die Antwort nicht die verlangte —
// sie würde als «Kapitel ohne Figuren/Orte/Szenen» gecacht. Wie eine Truncation ein
// nicht-fataler Chunk-Ausfall (kein Cache, Teilfehler-Warnung).
const CHUNK_REQUIRED = ['figuren', 'orte', 'szenen'];
function assertChunkFields(res, label) {
  const missing = CHUNK_REQUIRED.filter(k => !Array.isArray(res?.[k]));
  if (missing.length) throw i18nError('job.error.extractFieldMissing', { label: `${label} (${missing.join(', ')})` });
  return res;
}


/**
 * Multi-Pass Completeness-/Gap-Pass (nur Claude, grosse Bücher). Anders als der Single-Pass
 * bekommt hier jeder Chunk EINEN Basis-Extraktions-Durchlauf → der Long-Tail (Nebenfiguren,
 * einmal erwähnte Schauplätze/Fakten/Szenen) fällt pro Chunk systematisch durch. Dieser Pass
 * prompt't pro Chunk erneut (kombiniertes Gap-Schema), gesät mit dem GLOBAL bereits gefundenen
 * Katalog aller Chunks (Cross-Chunk-Dedup) → nur der genuine Long-Tail wird nachgezogen.
 * Loop-until-dry pro Chunk bis completenessPasses. Rein ADDITIV (mutiert `chapters` in place,
 * hängt fresh items an den jeweiligen Chunk-Eintrag). Eigener `:gap`-Cache pro Chunk → die
 * Basis-Chunk-Caches bleiben gültig. Läuft auf dem Extraktions-Tier, wird aber als eigener
 * Kosten-Bucket ausgewiesen (gapTier = extractTier + Label). NON-FATAL.
 */
async function runMultiPassCompletenessGaps(ctx, { chunkTexts, chapters, concurrency }) {
  const { jobId, bookIdInt, email, bookName, call, tok, log, effectiveProvider, prompts, sys, gapTier } = ctx;
  const completenessPasses = ctx.completenessPasses || 0;
  if (providerClass(effectiveProvider) !== 'cloud' || completenessPasses <= 0 || !chunkTexts.length) return;

  const claudeExtractCap = getContextConfigFor(effectiveProvider).maxTokensOut;
  const faktKey = (f) => `${f.subjekt || ''}: ${f.fakt || ''}`;
  const szeneKey = (s) => `${s.titel || ''} (${s.kapitel || ''})`;
  const STREAMS = [
    { name: 'figuren', arr: chapters.chapterFiguren, field: 'figuren', keyOf: (f) => f.name,   isValid: (f) => f && f.name },
    { name: 'orte',    arr: chapters.chapterOrte,    field: 'orte',    keyOf: (o) => o.name,   isValid: (o) => o && o.name },
    { name: 'fakten',  arr: chapters.chapterFakten,  field: 'fakten',  keyOf: faktKey,          isValid: (f) => f && f.fakt },
    { name: 'szenen',  arr: chapters.chapterSzenen,  field: 'szenen',  keyOf: szeneKey,         isValid: (s) => s && s.titel },
  ];
  // Global-Known (über alle Chunks) als Anzeige-Liste + Normalisierungs-Set pro Strom.
  const knownSet = {}, knownDisp = {};
  for (const s of STREAMS) {
    knownSet[s.name] = new Set();
    knownDisp[s.name] = [];
    for (const c of (s.arr || [])) for (const it of (c[s.field] || [])) {
      const k = _normalizeName(s.keyOf(it));
      if (!k || knownSet[s.name].has(k)) continue;
      knownSet[s.name].add(k); knownDisp[s.name].push(s.keyOf(it));
    }
  }

  updateJob(jobId, { statusText: 'job.phase.completenessChunks', statusParams: { n: chunkTexts.length } });
  const perChunk = await settledAll(chunkTexts.map(({ chunk, key, pagesSig, chText }, chunkIdx) => async () => {
    const chunkLabel = `Gap-Chunk ${chunkIdx + 1}/${chunkTexts.length} «${chunk.name}»`;
    const gapCacheKey = `${key}:gap`;
    // completeness_passes gehört nur in den Gap-Key (der Basis-Key bleibt bei einem Toggle gültig).
    const gapSig = `${pagesSig}||cp${completenessPasses}`;
    const cached = loadChapterExtractCache(bookIdInt, email, gapCacheKey, gapSig, effectiveProvider);
    if (cached) { log.info(`${chunkLabel} – Cache-HIT.`); return cached; }

    // Chunk-lokale Akkumulatoren, gesät mit dem globalen Known-Katalog.
    const seen = {}, disp = {}, fresh = {};
    for (const s of STREAMS) { seen[s.name] = new Set(knownSet[s.name]); disp[s.name] = knownDisp[s.name].slice(); fresh[s.name] = []; }
    // Gleicher Präfix wie der Basis-Call dieses Chunks → Kapiteltext per cache_read.
    const parts = _chunkCallParts(ctx, chunk, chText, sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS);
    let roundFailed = false;
    for (let round = 1; round <= completenessPasses; round++) {
      let res;
      try {
        res = await retryOnTransientAi(() => call(jobId, tok,
          prompts.buildChunkGapPrompt(chunk.name, bookName, chunk.pages.length, parts.chText, {
            figuren: disp.figuren, orte: disp.orte, fakten: disp.fakten, szenen: disp.szenen,
          }),
          parts.system, null, null, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_EXTRAKTION, gapTier,
        ), { log, label: `${chunkLabel} (Gap ${round}/${completenessPasses})` });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        log.warn(`${chunkLabel} Gap-Pass ${round} fehlgeschlagen (${e.message}) – übersprungen.`);
        roundFailed = true;
        break;
      }
      let anyNew = 0;
      for (const s of STREAMS) {
        for (const it of (res?.[s.field] || [])) {
          if (!s.isValid(it)) continue;
          const k = _normalizeName(s.keyOf(it));
          if (!k || seen[s.name].has(k)) continue;
          seen[s.name].add(k); disp[s.name].push(s.keyOf(it)); fresh[s.name].push(it); anyNew++;
        }
      }
      log.info(`${chunkLabel} Gap ${round}: +${anyNew} neu.`);
      if (anyNew === 0) break; // loop-until-dry
    }
    // Nach einer gescheiterten Runde NICHT cachen: der Teilstand (oft leer) läge sonst als
    // HIT fest, bis eine Seitenedition die Signatur ändert — der Long-Tail dieses Chunks
    // käme nie mehr. Die gefundenen Items gehen trotzdem in diesen Lauf ein.
    if (roundFailed) log.warn(`${chunkLabel} – Gap-Cache übersprungen (Teilfehler), nächster Lauf zieht neu nach.`);
    else saveChapterExtractCache(bookIdInt, email, gapCacheKey, gapSig, fresh, effectiveProvider);
    return fresh;
  }), (chunkTexts.length > concurrency ? { concurrency } : {}));

  // Additiv in die per-Chunk-Kapiteleinträge mergen (extractField hält Index-Alignment zu chunkTexts).
  const totals = { figuren: 0, orte: 0, fakten: 0, szenen: 0 };
  for (let i = 0; i < perChunk.length; i++) {
    if (perChunk[i].status !== 'fulfilled' || !perChunk[i].value) continue;
    const f = perChunk[i].value;
    for (const s of STREAMS) {
      const items = f[s.name];
      if (!items?.length || !s.arr[i]) continue;
      if (s.name === 'figuren') appendFigurenKollisionsfrei(s.arr[i][s.field], items);
      else s.arr[i][s.field].push(...items);
      totals[s.name] += items.length;
    }
  }
  if (totals.figuren || totals.orte || totals.fakten || totals.szenen)
    log.info(`Multi-Pass Completeness: +${totals.figuren} Figuren, +${totals.orte} Orte, +${totals.fakten} Fakten, +${totals.szenen} Szenen.`);
}

/**
 * Basis-Extraktion eines Cloud-Chunks auf dem Extraktions-Tier (Modell + Effort aus
 * ai.claude.*.komplett.extract, wie Single-Pass und Gap-Pässe). Truncation am Output-Cap
 * ist bei einem Cloud-Modell kein Wiederholungs-Loop wie lokal, sondern schlicht zu viel
 * Stoff für einen Call: der Chunk wird EINMAL halbiert (seitenweise; ein Chunk aus nur einem
 * Abschnitt bzw. Abschnitts-Teil an der Absatz-/Satzgrenze nächst der Mitte, gleiche Identität,
 * shared/chunking.js#halveChunkPages) und die Hälften einzeln
 * extrahiert (Text im User-Turn, ohne Cache — nur dieser eine Rettungsweg liest ihn).
 * Ohne das trüge das Kapitel nichts bei, würde nie gecacht und truncierte in jedem
 * Folgelauf erneut (bezahlt, verworfen). Truncieren auch die Hälften → Fehler wie bisher.
 */
async function _extractCloudChunk(ctx, { chunk, chText, chunkLabel, claudeExtractCap }) {
  const { jobId, bookName, call, tok, log, prompts, sys, extractTier } = ctx;
  const parts = _chunkCallParts(ctx, chunk, chText, sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS);
  const extractOnce = (label, pages, sysBlocks, text) => retryOnTransientAi(() => call(jobId, tok,
    prompts.buildExtraktionKomplettChapterPrompt(chunk.name, bookName, pages.length, text, ctx.katalogBlock),
    sysBlocks, null, null, claudeExtractCap, 0.2, null, prompts.SCHEMA_KOMPLETT_EXTRAKTION, extractTier,
  ), { log, label }).then(res => assertChunkFields(res, label));
  try {
    return await extractOnce(chunkLabel, chunk.pages, parts.system, parts.chText);
  } catch (e) {
    if (e?.message !== 'job.error.aiTruncated') throw e;
    const halves = halveChunkPages(chunk.pages);
    if (!halves) throw e;
    log.warn(`${chunkLabel} – Truncation, Retry in zwei Hälften (${halves[0].length}+${halves[1].length} Seiten${chunk.pages.length === 1 ? ', Abschnitt geteilt' : ''}).`);
    const results = [];
    for (const [hi, pages] of halves.entries()) {
      const text = pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n');
      results.push(await extractOnce(`${chunkLabel} Hälfte ${hi + 1}/2`, pages, sys.SYSTEM_KOMPLETT_EXTRAKTION_BLOCKS, text));
    }
    return _concatExtractResults(results[0], results[1]);
  }
}

/**
 * Multi-Pass mit Delta-Cache (grosse Bücher / lokale Provider): Kapitel → Chunks, einzeln
 * extrahiert + pro Chunk gecacht. Gibt `{ chapters, partialFailure }` zurück — partialFailure
 * bei nicht-fataler Chunk-Truncation (Cache-Skip pro Chunk + Checkpoint-Skip).
 */
async function extractMultiPass(ctx, { chunks, chunkOrder, claudeExtractCap, callExtract }) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, effectiveProvider, prompts, sys } = ctx;
  const chunkCacheVersion = ctx.chunkCacheVersion ?? ctx.cacheVersion;
  let partialFailure = false;

  // Lokale Modelle: Kapitel über PER_CHUNK_LIMIT in Seiten-Untergruppen splitten, jeder Chunk
  // mit eigenem KI-Call + Delta-Cache-Eintrag. Claude: singlePassLimit als Grenze → kein Split.
  updateJob(jobId, { progress: 12, statusText: 'job.phase.extractingChunks', statusParams: { n: chunkOrder.length } });
  // Settings-Anteil identisch zum Single-Pass-Key (buildBookPagesSig): Buchtyp/
  // Kontext fliessen in den Extraktions-Prompt, also muss ihr Wechsel auch die
  // Per-Chunk-Caches invalidieren – sonst liefert der Multi-Pass-Cache stale
  // Extraktion mit den alten Autoren-Vorgaben.
  const settingsSig = bookSettingsSigPart(getBookSettings(bookIdInt, email));
  const chunkTexts = chunkOrder.map((chunkKey, ord) => {
    const chunk = chunks.get(chunkKey);
    return {
      chunk, key: chunkKey, ord,
      // Kapitelname im Sig: er fliesst via buildExtraktionKomplettChapterPrompt(chunk.name)
      // in den Prompt, steht aber nicht in page_id:updated_at. Ohne ihn liefert eine reine
      // Kapitel-Umbenennung einen stale Cache-HIT mit altem Kapitelkontext. Rename → MISS.
      pagesSig: chunk.pages.map(p => `${p.id}:${p.updated_at}${pageSigSuffix(p)}`).sort().join('|') + `||${settingsSig}||ch:${chunk.name || ''}||${chunkCacheVersion || ''}`,
      chText: chunk.pages.map(p => `### ${p.title}\n${p.text}`).join('\n\n---\n\n'),
    };
  });
  // Claude-Warmup laeuft seriell (settledAll(..., {warmup:true})) und schreibt
  // den Prompt-Cache fuer die parallelen Folge-Chunks. Damit der serielle
  // Pass keine Verzoegerung kostet, faengt der kleinste Chunk an
  // (Seitenzahl als Proxy; bei Gleichstand stabile chunkOrder-Reihenfolge).
  if (effectiveProvider === 'claude' && chunkTexts.length > 1) {
    const minIdx = chunkTexts.reduce((best, ct, i, arr) =>
      ct.chunk.pages.length < arr[best].chunk.pages.length ? i : best, 0);
    if (minIdx > 0) {
      const [smallest] = chunkTexts.splice(minIdx, 1);
      chunkTexts.unshift(smallest);
    }
  }
  let cacheHits = 0;
  // Für lokale Modelle zweigeteilte Extraktion: Pass A (figuren+assignments) / Pass B
  // (orte+fakten+szenen), Cache-Keys `${key}:figuren` / `${key}:orte` (getrennt von alten
  // kombinierten Caches, damit die sauber neu entstehen statt fälschlich getroffen zu werden).
  // Klassen-, nicht Namensfrage: ein gehostetes Frontier-Modell ueber openai-compat
  // haelt den kombinierten Pass genauso durch wie Claude (lib/ai/config.js#providerClass).
  const isSplit = providerClass(effectiveProvider) !== 'cloud';
  // Claude-Multi-Pass: Anthropic-TPM-Burst dämpfen. warmup: Erst-Chunk seriell → schreibt
  // den Cache der geteilten System-Blöcke, Folge-Chunks lesen ihn. Steht der Kapiteltext
  // vorne (Gap-Pass an, _chunkCallParts), teilen die Chunks keinen Präfix mehr — dann
  // dämpft der Warmup nur noch die Request-Rate. concurrency-Cap:
  // max. ai.claude.phase1_concurrency (Default 4, belastbar gegen Tier-1/2 bei ~25k tok/Chunk).
  const claudeConcurrency = Math.max(1, parseInt(appSettings.get('ai.claude.phase1_concurrency'), 10) || 4);
  const settledOpts = (effectiveProvider === 'claude' && chunkTexts.length > claudeConcurrency)
    ? { concurrency: claudeConcurrency, warmup: true }
    : {};
  if (settledOpts.warmup) {
    log.info(`Phase 1 Multi-Pass – ${chunkTexts.length} Chunks, Warmup-Pass + Concurrency=${claudeConcurrency} (TPM-Schutz).`);
  }
  // Progress pro abgeschlossenem Chunk bumpen – nicht via aiCall-Stream: parallele Chunks
  // würden sonst alle in 12-28 ticken und der schnellste Stream die Bar früh ans Ende clampen.
  // Monotone Chunk-Completion-Updates = ehrlicher Verlauf.
  let chunksDone = 0;
  const bumpChunkProgress = () => {
    chunksDone++;
    updateJob(jobId, { progress: 12 + Math.round((chunksDone / chunkTexts.length) * 16) });
  };
  const settled = await settledAll(
    chunkTexts.map(({ chunk, key, pagesSig, chText }, chunkIdx) => async () => {
      const chunkLabel = `Chunk ${chunkIdx + 1}/${chunkTexts.length} «${chunk.name}»`;
      log.info(`${chunkLabel} – ${chunk.pages.length} Seiten${isSplit ? ' (Split-Pässe)' : ''}`);

      if (!isSplit) {
        const cachedChunk = loadChapterExtractCache(bookIdInt, email, key, pagesSig, effectiveProvider);
        if (cachedChunk) { cacheHits++; log.info(`${chunkLabel} – Cache-HIT.`); bumpChunkProgress(); return cachedChunk; }
        log.info(`${chunkLabel} – Cache-MISS, KI-Call…`);
        const result = await _extractCloudChunk(ctx, { chunk, chText, chunkLabel, claudeExtractCap });
        saveChapterExtractCache(bookIdInt, email, key, pagesSig, result, effectiveProvider);
        log.info(`${chunkLabel} – OK (fig=${result?.figuren?.length ?? 0} orte=${result?.orte?.length ?? 0} songs=${result?.songs?.length ?? 0} sz=${result?.szenen?.length ?? 0}).`);
        bumpChunkProgress();
        return result;
      }

      const figKey = `${key}:figuren`;
      const ortKey = `${key}:orte`;
      const cachedFig = loadChapterExtractCache(bookIdInt, email, figKey, pagesSig, effectiveProvider);
      const cachedOrt = loadChapterExtractCache(bookIdInt, email, ortKey, pagesSig, effectiveProvider);

      let passA = cachedFig;
      if (passA) { cacheHits++; log.info(`${chunkLabel} Pass A (Figuren) – Cache-HIT.`); }
      else {
        log.info(`${chunkLabel} Pass A (Figuren) – KI-Call…`);
        passA = await callExtract(`${chunkLabel} Pass A`,
          prompts.buildExtraktionFigurenPassPrompt(chunk.name, bookName, chunk.pages.length, chText, ctx.katalogBlock),
          sys.SYSTEM_KOMPLETT_FIGUREN_PASS_BLOCKS, null, null, 8000, prompts.SCHEMA_KOMPLETT_FIGUREN_PASS);
        saveChapterExtractCache(bookIdInt, email, figKey, pagesSig, passA, effectiveProvider);
      }

      let passB = cachedOrt;
      if (passB) { cacheHits++; log.info(`${chunkLabel} Pass B (Orte/Szenen) – Cache-HIT.`); }
      else {
        log.info(`${chunkLabel} Pass B (Orte/Szenen) – KI-Call…`);
        passB = await callExtract(`${chunkLabel} Pass B`,
          prompts.buildExtraktionOrtePassPrompt(chunk.name, bookName, chunk.pages.length, chText, ctx.katalogBlock),
          sys.SYSTEM_KOMPLETT_ORTE_PASS_BLOCKS, null, null, 6000, prompts.SCHEMA_KOMPLETT_ORTE_PASS);
        saveChapterExtractCache(bookIdInt, email, ortKey, pagesSig, passB, effectiveProvider);
      }

      const merged = {
        figuren:     passA?.figuren     || [],
        assignments: passA?.assignments || [],
        orte:        passB?.orte        || [],
        songs:       passB?.songs       || [],
        fakten:      passB?.fakten      || [],
        szenen:      passB?.szenen      || [],
      };
      log.info(`${chunkLabel} – Split-OK (fig=${merged.figuren.length} orte=${merged.orte.length} songs=${merged.songs.length} sz=${merged.szenen.length}).`);
      bumpChunkProgress();
      return merged;
    }),
    settledOpts,
  );

  // Buchreihenfolge wiederherstellen: der Warmup zog den kleinsten Chunk nach vorn, und
  // die Reihenfolge der Kapiteleinträge wird zur sort_order der Welt-Fakten.
  if (chunkTexts.some((ct, i) => ct.ord !== i)) {
    const idx = chunkTexts.map((_, i) => i).sort((a, b) => chunkTexts[a].ord - chunkTexts[b].ord);
    const ctSorted = idx.map(i => chunkTexts[i]);
    const stSorted = idx.map(i => settled[i]);
    chunkTexts.splice(0, chunkTexts.length, ...ctSorted);
    settled.splice(0, settled.length, ...stSorted);
  }
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'rejected')
      log.warn(`Vollextraktion «${chunkTexts[i].chunk.name}» übersprungen: ${settled[i].reason?.message}`);
  }
  const chapters = {
    chapterFiguren:     extractField(settled, chunkTexts, 'figuren'),
    chapterOrte:        extractField(settled, chunkTexts, 'orte'),
    chapterSongs:       extractField(settled, chunkTexts, 'songs'),
    chapterFakten:      extractField(settled, chunkTexts, 'fakten'),
    chapterSzenen:      extractField(settled, chunkTexts, 'szenen'),
    chapterAssignments: extractField(settled, chunkTexts, 'assignments'),
  };

  const failedChunks = settled.filter(r => r.status === 'rejected');
  const cacheLookups = chunkTexts.length * (isSplit ? 2 : 1);
  log.info(`Phase 1 Multi-Pass – ${settled.length - failedChunks.length}/${settled.length} OK (${cacheHits}/${cacheLookups} Cache-Hits), fig=${chapters.chapterFiguren.reduce((s, c) => s + c.figuren.length, 0)} orte=${chapters.chapterOrte.reduce((s, c) => s + c.orte.length, 0)} songs=${chapters.chapterSongs.reduce((s, c) => s + (c.songs?.length || 0), 0)} sz=${chapters.chapterSzenen.reduce((s, c) => s + c.szenen.length, 0)}`);
  if (failedChunks.length > 0) {
    const failedInfo = chunkTexts
      .map((ct, i) => ({ ct, r: settled[i] }))
      .filter(({ r }) => r.status === 'rejected')
      .map(({ ct, r }) => ({ name: ct.chunk.name, message: r.reason?.message || 'unbekannt' }));
    const details = failedInfo.map(f => `${f.name}: ${f.message}`).join('; ');
    const SOFT = new Set(['job.error.aiTruncated', 'job.error.extractFieldMissing']);
    const onlyTruncation = failedInfo.every(f => SOFT.has(f.message));
    const someSucceeded = (settled.length - failedChunks.length) > 0;
    // Truncation einzelner Chunks ist nicht-fatal, SOLANGE mindestens ein Chunk
    // Daten lieferte: das lokale Modell dreht bei dichten Kapiteln in Wiederholungs-
    // schleifen (kein Cap fixt das — repeat_penalty mildert es). Betroffene
    // (Teil-)Chunks tragen dann nichts bei; wiederkehrende Figuren/Orte werden über
    // die übrigen Chunks meist trotzdem erfasst. Andere Fehlerarten (Provider down,
    // Parse-Fehler) ODER ein Totalausfall (0 OK) bleiben hart — dann hat Phase 1
    // keine verlässliche Basis und der Job bricht ehrlich ab, statt ein leeres
    // Ergebnis als „fertig" auszugeben.
    if (onlyTruncation && someSucceeded) {
      // Teilfehler: Checkpoint überspringen (wie der Cache-Skip oben). Sonst friert ein
      // Crash nach Phase 1 die truncierten/fehlenden Chunks ein; der Resume lädt den
      // lückenhaften Stand statt die nie gecachten Chunks erneut zu extrahieren.
      partialFailure = true;
      const skippedChapters = [...new Set(failedInfo.map(f => f.name))];
      // Diese Kapitel behalten beim Speichern ihre bisherigen Welt-Fakten (saveFaktenToDb
      // keepChapterIds) — ein ausgefallener Chunk ist keine Aussage „hier gibt es keine".
      ctx.faktenFailure = { all: false, kapitel: skippedChapters };
      log.warn(`Phase 1 – ${failedChunks.length} Chunk(s) durch Truncation übersprungen (nicht-fatal): ${details}`);
      ctx.warnings?.push({
        key: 'job.warn.chunksTruncated',
        params: { count: failedChunks.length, chapters: skippedChapters.join(', ') },
      });
    } else {
      throw i18nError('job.error.phase1Incomplete', { count: failedChunks.length, details });
    }
  }

  // Completeness-/Gap-Pass (nur Claude): pro Chunk den Long-Tail nachziehen, den der
  // eine Basis-Durchlauf ausgelassen hat. Additiv, non-fatal, eigener :gap-Cache.
  await runMultiPassCompletenessGaps(ctx, { chunkTexts, chapters, concurrency: claudeConcurrency });

  return { chapters, partialFailure };
}

module.exports = { extractMultiPass, appendFigurenKollisionsfrei };
