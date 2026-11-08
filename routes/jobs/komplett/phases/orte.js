'use strict';
// Phase 3: Orte + Songs konsolidieren (inkl. regelbasierter Fallback-Merges) +
// Prelim-figurenKompakt + paralleler Orte-Call (Multi-Pass). Die puren Merges liegen in
// ./orte/orte-merge.js und ./orte/songs-merge.js und werden hier mit exportiert.
const { saveOrteToDb, saveSongsToDb, planOrteMatch } = require('../../../../db/schema');
const { listSongIdsForBook } = require('../../../../db/songs');
const searchIndex = require('../../../../lib/search');
const { updateJob, i18nErrText } = require('../../shared');
const { _remapFigNames, consolidationFitsCap, skippedChapterIds } = require('../utils');
const { komplettMaxTokens } = require('./tokens');
const { getContextConfigFor } = require('../../../../lib/ai');
const { COST_LABEL, costTier } = require('../cost-labels');
const { dedupeLocationsWithinRun } = require('../../../../lib/entity-match');
const { judgeEntityPairs } = require('../entity-reconcile');
const { ankerHints, mergeHints } = require('../katalog-anker');
const { locationHintKey } = require('../../../../lib/entity-match');
const { countActiveLocations } = require('../../../../db/katalog-anker');
const { loadOrteFromDb, countSongsInDb } = require('../scope');
const { PHASE_END } = require('../../../../lib/komplett-scope');
const { foldIncomingAliases } = require('../../../../db/location-aliases');
const { buildFallbackOrte, restoreOmittedOrte, buildOrtNameLookup, ortAliasesFromSources } = require('./orte/orte-merge');
const {
  dedupeSongsWithinRun, remapSongFiguren, withFiguren: _withFiguren, buildFallbackSongs, restoreOmittedSongs,
} = require('./orte/songs-merge');

// Kollaps-Riegel wie bei den Figuren (phases/figuren.js): liefert die Konsolidierung bei
// einem gewachsenen Bestand (fast) nichts, würde der Reconcile den ganzen Ortskatalog
// ausmustern bzw. saveSongsToDb die Musikbibliothek samt Deep-Links löschen. Dann bleibt
// der Bestand stehen, und der Lauf meldet die Degradierung. Anders als bei den Figuren
// (dort Abbruch, Begründung in phases/figuren.js) hängt an Orten und Songs kein späterer
// Schritt, der die IDs dieses Laufs bräuchte.
const KOLLAPS_MIN_BESTAND = 5;
const KOLLAPS_MIN_ANTEIL = 0.3;
function _kollabiert(bestand, neu) {
  return bestand >= KOLLAPS_MIN_BESTAND && neu < Math.ceil(bestand * KOLLAPS_MIN_ANTEIL);
}

/** Phase 3: Orte konsolidieren + Name→ID Lookup.
 *  Single-Pass-Optimierung analog zu Phase 2: Wenn Phase 1 im Single-Pass-Modus lief,
 *  sind die Orte bereits holistisch extrahiert – ein Konsolidierungs-Call fügt nichts
 *  hinzu und kostet ~15K Tokens. Die Figuren-Referenzen der Orte kommen als Klarnamen
 *  (figuren_namen) und werden nach P2 via figNameToId/figNameToIdLower (exakt + lowercase-
 *  Fallback) zu kanonischen fig_ids aufgelöst – nicht auflösbare Namen werden verworfen. */
async function runPhase3(ctx, chapterOrte, figurenKompakt, isSinglePass, figNameToId, figNameToIdLower, opts = {}) {
  // bookName/effectiveProvider bewusst nicht hier: Prompt-Bau und Output-Cap liegen in
  // _orteKonsolPrompt, das sie selbst aus ctx zieht.
  const { jobId, bookIdInt, email, call, tok, log, prompts, sys, idMaps } = ctx;
  // prefetchAttempted: im Claude-Parallel-Pfad wurde der Orte-Call bereits gefahren (Promise.all).
  // null heisst dann „Prefetch fehlgeschlagen" (Warnung schon geloggt) → direkt Fallback, kein Re-Call.
  const prefetchAttempted = 'prefetchedOrteRaw' in opts;
  const prefetched = opts.prefetchedOrteRaw || null;

  let orte;
  // Namen, die in einem Ort aufgegangen sind (Within-Run-Dedup bzw. KI-Konsolidierung),
  // je Ort-Index: Szenen tragen in `orte_namen` noch den Kapitel-Namen, und ohne Alias
  // fiele ihre Ort-Verknüpfung in remapSzenen still weg.
  let aliasesByIdx = [];
  if (isSinglePass) {
    updateJob(jobId, { progress: PHASE_END.figurenConsolidate, statusText: 'job.phase.consolidatingOrte' });
    const raw = chapterOrte[0]?.orte || [];
    // Within-Run-Dedup: der Single-Pass fährt KEINE KI-Konsolidierung (spart einen Call),
    // aber die Completeness-Gap-Pässe ziehen Schreibvarianten desselben Orts nach
    // («Frohheim-Schule Olten» / «Frohheim-Schulhaus Olten»). Konservativ per Token-
    // Teilmenge verschmelzen, bevor IDs vergeben werden — sonst landen sie als Dubletten.
    const { orte: deduped, unsure: dedupUnsure, aliases: dedupAliases } = dedupeLocationsWithinRun(raw);
    aliasesByIdx = dedupAliases || [];
    // Within-Run-Verdachtsfaelle bleiben bewusst GETRENNT und gehen NICHT an den Judge:
    // sein Hint-Mechanismus zeigt auf eine Bestands-Zeile (Cross-Run), zwei Eintraege
    // desselben Laufs zusammenzufuehren waere ein anderer Eingriff. Sie fallen beim
    // naechsten Lauf ohnehin in den Cross-Run-Graubereich, wo der Judge sie sieht.
    if (dedupUnsure.length) {
      log.info(`Orte-Within-Run: ${dedupUnsure.length} aehnliche Paar(e) bewusst getrennt gelassen `
        + `(z.B. ${dedupUnsure.slice(0, 2).map(u => `«${u.a}» ~ «${u.b}»`).join(', ')}).`);
    }
    orte = deduped.map((o, i) => ({
      ...o,
      // loc_id run-intern IMMER sequenziell neu vergeben (nicht o.id||-Fallback): der
      // Single-Pass-Completeness-Gap (runPhase1) kann ort_1… doppelt erzeugen, wenn der
      // Erst-Pass id-lose Orte lieferte → Kollision im konkatenierten Array →
      // UNIQUE(book_id, loc_id, user_email) in saveOrteToDb. Das Handle ist frei wählbar
      // (ortNameToId wird daraus gebaut; downstream zählt die DB-id). Orte haben — anders
      // als Figuren — kein ensureUniqueLocIds-Netz, darum hier deterministisch durchnummerieren.
      id: 'ort_' + (i + 1),
      figuren: _remapFigNames(o.figuren_namen, figNameToId, figNameToIdLower),
    }));
    const mergedN = raw.length - deduped.length;
    log.info(`Phase 3 übersprungen (Single-Pass, ${orte.length} Orte aus P1 übernommen`
      + `${mergedN > 0 ? `, ${mergedN} Varianten verschmolzen` : ''}) – spart einen KI-Call.`);
    updateJob(jobId, { progress: PHASE_END.orteConsolidate });
  } else {
    updateJob(jobId, { progress: PHASE_END.figurenConsolidate, statusText: 'job.phase.consolidatingOrte' });
    let orteResultRaw = prefetched;
    // Quellnamen der KI-Konsolidierung (Kapitelname → Ausgabe-Ort), für die Aliasse unten.
    let quellOf = new Map();
    // Prompt erst hier bauen: im Parallel-Pfad (prefetchAttempted) ist der Call längst
    // gelaufen, und der Prompt trägt den ganzen Ortskatalog — ihn dort zu bauen wäre
    // ein grosser String für nichts.
    if (!orteResultRaw && !prefetchAttempted) {
      const { promptText, cap, fit } = _orteKonsolPrompt(ctx, chapterOrte, figurenKompakt);
      if (!fit.fits) {
        // Preflight wie in Phase 2: passt die Antwort nicht unter den Cap, ist die Truncation
        // sicher und ihr Ausgang derselbe regelbasierte Merge — dann ohne Umweg dorthin.
        log.warn(`Orte-Konsolidierung übersprungen – erwarteter Output ~${fit.estOut} Tokens über dem `
          + `Cap ${fit.cap} (Truncation wäre sicher). Fallback auf kapitel-extrahierte Orte. `
          + 'Abhilfe: ai.komplett.extract_max_tokens erhöhen.');
        ctx.warnings?.push({ key: 'job.warn.orteKonsolidierungDegraded' });
        orteResultRaw = null;
      } else {
        try {
          // Cap im maxTokens-Slot (9. Argument, Muster phases/extraktion.js) — im
          // expectedChars-Slot wäre er nur eine Fortschritts-Schätzung.
          orteResultRaw = await call(jobId, tok,
            promptText,
            sys.SYSTEM_ORTE_BLOCKS, 43, 55, null, 0.2, cap, prompts.SCHEMA_ORTE_KONSOL,
            costTier(COST_LABEL.orte),
          );
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          // Wie Phase 2 (Figuren) / Zeitstrahl: die Orte-Konsolidierung ist nicht
          // katalog-kritisch – die Orte sind in chapterOrte bereits kapitelweise extrahiert.
          // Ein Konsolidierungs-Fehler (typisch: aiTruncated, wenn ein kleines lokales Modell
          // viele Orte in einen Output packen müsste, Parse-Fehler, erschöpfter Retry) darf den
          // gesamten Job – inkl. bereits gespeicherter Figuren/Soziogramm/Fakten – NICHT verwerfen.
          log.warn(`Orte-Konsolidierung fehlgeschlagen (${i18nErrText(e)}) – Fallback auf kapitel-extrahierte Orte.`);
          ctx.warnings?.push({ key: 'job.warn.orteKonsolidierungDegraded' });
          orteResultRaw = null;
        }
      }
    }
    if (!Array.isArray(orteResultRaw?.orte)) {
      // Call gescheitert ODER Antwort ohne orte-Array: kapitelweise extrahierte Orte
      // regelbasiert mergen (flatten + Dedup nach Name, figuren_namen → fig_id aufgelöst).
      if (orteResultRaw !== null) {
        log.warn('Orte-Konsolidierung lieferte kein orte-Array – Fallback auf kapitel-extrahierte Orte.');
        ctx.warnings?.push({ key: 'job.warn.orteKonsolidierungDegraded' });
      }
      orte = buildFallbackOrte(chapterOrte, figNameToId, figNameToIdLower);
      updateJob(jobId, { progress: PHASE_END.orteConsolidate });
    } else {
      // Was das Modell weggelassen hat, kommt aus den Kapitel-Orten zurück — sonst
      // markierte der Abgleich den Bestandsort als «nicht mehr im Text».
      const res = restoreOmittedOrte(orteResultRaw.orte, chapterOrte, figNameToId, figNameToIdLower);
      quellOf = res.quellOf;
      if (res.restored.length) {
        log.info(`Orte-Konsolidierung: ${res.restored.length} von der KI weggelassene Ort(e) aus den Kapiteln übernommen: `
          + `${res.restored.slice(0, 5).map(o => `«${o.name}»`).join(', ')}${res.restored.length > 5 ? ', …' : ''}.`);
      }
      orte = [...orteResultRaw.orte, ...res.restored];
      updateJob(jobId, { progress: PHASE_END.orteConsolidate });
    }
    // Beide Multi-Pass-Wege (KI-Konsolidierung, regelbasierter Fallback) wie der
    // Single-Pass durch den Varianten-Dedup: die KI liefert denselben Ort gelegentlich
    // doppelt, der Fallback führt nur exakt gleiche Namen zusammen — ohne Dedup ordnet
    // der Abgleich nur einen davon dem Bestand zu, der andere wird eine neue Zeile.
    // Danach id IMMER neu vergeben (eine doppelte ort_N liefe in UNIQUE(book_id, loc_id,
    // user_email)) und figuren_namen → fig_ids auflösen.
    const { orte: deduped, aliases: dedupAliases } = dedupeLocationsWithinRun(orte);
    orte = deduped.map((o, i) => ({
      ...o,
      id: 'ort_' + (i + 1),
      figuren: _remapFigNames(o.figuren_namen, figNameToId, figNameToIdLower),
    }));
    const srcAliases = ortAliasesFromSources(orte, chapterOrte, quellOf, dedupAliases);
    aliasesByIdx = orte.map((_, i) => [...new Set([...(dedupAliases?.[i] || []), ...(srcAliases[i] || [])])]);
  }
  // Name-Match + stale: locations.id bleibt ueber Re-Analysen stabil (FK-Refs wie
  // research_item_links.location_id ueberleben); verschwundene Orte werden als stale
  // markiert statt geloescht (kein CASCADE auf die Verknuepfungen).
  // Graubereich des Cross-Run-Matchings vom Judge beurteilen lassen, BEVOR gespeichert
  // wird (Begründung siehe entity-reconcile.js): «Kreuz (Olten)» vs. «Kreuz (Bern)»
  // trennt die Regel selbst, «Schulhaus Frohheim» vs. «Frohheim-Schule Olten» nicht.
  // Aliasse aus manuellen Merges: liefert der Lauf Name und Alias desselben Orts,
  // werden sie hier ein Eintrag; der Alias-Name bleibt für die Szenen auflösbar.
  {
    const folded = foldIncomingAliases(bookIdInt, email, orte);
    if (folded.orte !== orte) {
      const keptAliases = [];
      let k = 0;
      for (let i = 0; i < orte.length && k < folded.orte.length; i++) {
        if (orte[i].id === folded.orte[k].id) { keptAliases.push(aliasesByIdx[i] || []); k++; }
      }
      orte = folded.orte;
      aliasesByIdx = orte.map((_, i) => [...(keptAliases[i] || []), ...folded.foldedNames[i]]);
    }
  }
  const bestand = countActiveLocations(bookIdInt, email);
  if (_kollabiert(bestand, orte.length)) {
    log.error(`Orte-Konsolidierung kollabiert: ${orte.length} Orte gegen ${bestand} aktive im Katalog – Bestand bleibt.`);
    ctx.warnings?.push({ key: 'job.warn.orteKollaps', params: { neu: orte.length, aktiv: bestand } });
    return loadOrteFromDb(bookIdInt, email);
  }
  // Katalog-Anker zuerst, dann der Judge für den Rest-Graubereich (wie Phase 2).
  const anker = ctx.katalogAnker
    ? ankerHints(orte, { prefix: 'O', validIds: ctx.katalogAnker.ortIds, keyOf: locationHintKey })
    : { hint: new Map(), conflicts: 0 };
  if (anker.hint.size || anker.conflicts) {
    log.info(`Katalog-Anker Orte: ${anker.hint.size} verankert${anker.conflicts ? `, ${anker.conflicts} doppelt beanspruchte Katalog-IDs der Regel überlassen` : ''}.`);
  }
  let ortHint = anker.hint.size ? anker.hint : null;
  try {
    const plan = planOrteMatch(bookIdInt, orte, email, idMaps.chNameToId, ortHint);
    if (plan.unsure.length) {
      const judged = await judgeEntityPairs(ctx, 'ort', { incoming: orte, existing: plan.existing, unsure: plan.unsure });
      if (judged?.size) ortHint = mergeHints(anker.hint, judged);
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    log.warn(`Orte-Match-Judge übersprungen (${i18nErrText(e)}) – Matching bleibt regelbasiert.`);
  }
  saveOrteToDb(bookIdInt, orte, email, idMaps.chNameToId, idMaps.pageNameToIdByChapter,
    { preserveExistingCoords: true, matchBy: 'name', onMissing: 'stale',
      keepChapterIds: skippedChapterIds(ctx),
      matchHint: ortHint && ortHint.size ? ortHint : null });
  log.info(`${orte.length} Schauplätze gespeichert.`);

  const { ortNameToId, ortNameToIdLower } = buildOrtNameLookup(orte, aliasesByIdx);
  return { orte, ortNameToId, ortNameToIdLower };
}

/** Phase 3 Songs: Musikbibliothek konsolidieren analog zu Orten.
 *  Single-Pass: Songs aus Pass B übernehmen (figuren_namen → fig_id via figNameToId aufgelöst).
 *  Multi-Pass: KI-Call konsolidiert dedupliziert (Titel+Interpret) über alle Kapitel. */
async function runPhase3Songs(ctx, chapterSongs, figurenKompakt, isSinglePass, figNameToId, figNameToIdLower) {
  const { jobId, bookIdInt, bookName, email, call, tok, log, prompts, sys, idMaps, effectiveProvider } = ctx;

  let songs;
  if (isSinglePass) {
    updateJob(jobId, { progress: PHASE_END.songsConsolidate, statusText: 'job.phase.consolidatingSongs' });
    const raw = chapterSongs[0]?.songs || [];
    songs = dedupeSongsWithinRun(_withFiguren(raw, figNameToId, figNameToIdLower));
    log.info(`Phase 3 Songs übersprungen (Single-Pass, ${songs.length} Songs aus P1 übernommen).`);
  } else {
    updateJob(jobId, { statusText: 'job.phase.consolidatingSongs' });
    const hasInput = chapterSongs.some(cs => (cs.songs || []).length > 0);
    if (!hasInput) {
      songs = [];
      updateJob(jobId, { progress: PHASE_END.songsConsolidate });
      log.info(`Phase 3 Songs übersprungen (keine Songs in Pass B – KI-Call gespart).`);
    } else {
      // Songs-Range 55→56 (klein, ~3K Out): lässt 56→58 frei für P3b.
      let songsResultRaw = null;
      const promptText = prompts.buildSongsConsolidationPrompt(bookName, chapterSongs, figurenKompakt);
      const cap = komplettMaxTokens(effectiveProvider);
      const fit = consolidationFitsCap({
        promptText, dataText: JSON.stringify(chapterSongs.flatMap(c => c.songs || [])),
        charsPerToken: getContextConfigFor(effectiveProvider).charsPerToken, cap,
      });
      if (!fit.fits) {
        // Preflight wie bei den Orten: passt die Antwort nicht unter den Cap, ist die
        // Truncation sicher und ihr Ausgang derselbe regelbasierte Merge — ohne Umweg dorthin.
        log.warn(`Songs-Konsolidierung übersprungen – erwarteter Output ~${fit.estOut} Tokens über dem `
          + `Cap ${fit.cap} (Truncation wäre sicher). Fallback auf kapitel-extrahierte Songs. `
          + 'Abhilfe: ai.komplett.extract_max_tokens erhöhen.');
        ctx.warnings?.push({ key: 'job.warn.songsKonsolidierungDegraded' });
      } else {
        try {
          songsResultRaw = await call(jobId, tok,
            promptText,
            sys.SYSTEM_ORTE_BLOCKS, 55, 56, undefined, 0.2, cap, prompts.SCHEMA_SONGS_KONSOL,
            costTier(COST_LABEL.orte),
          );
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          // Wie Orte/Figuren/Zeitstrahl: nicht katalog-kritisch – die Songs sind kapitelweise
          // bereits extrahiert. Ein Konsolidierungs-Fehler (typisch: aiTruncated) darf den Job
          // inkl. bereits gespeicherter Figuren/Orte NICHT verwerfen.
          log.warn(`Songs-Konsolidierung fehlgeschlagen (${i18nErrText(e)}) – Fallback auf kapitel-extrahierte Songs.`);
          ctx.warnings?.push({ key: 'job.warn.songsKonsolidierungDegraded' });
        }
      }
      if (Array.isArray(songsResultRaw?.songs)) {
        // Die id der KI wird verworfen: doppelt oder fehlend liefe sie in
        // UNIQUE(book_id, song_uid, user_email) und braeche die Transaktion.
        // Weggelassene Kapitel-Songs zurückholen, bevor saveSongsToDb sie samt Deep-Links löscht.
        const restored = restoreOmittedSongs(songsResultRaw.songs, chapterSongs, figNameToId, figNameToIdLower);
        if (restored.length) {
          log.info(`Songs-Konsolidierung: ${restored.length} von der KI weggelassene Song(s) aus den Kapiteln übernommen: `
            + `${restored.slice(0, 5).map(x => `«${x.titel}»`).join(', ')}${restored.length > 5 ? ', …' : ''}.`);
        }
        songs = dedupeSongsWithinRun([..._withFiguren(songsResultRaw.songs, figNameToId, figNameToIdLower), ...restored]);
      } else {
        if (songsResultRaw !== null) {
          log.warn('Songs-Konsolidierung lieferte kein songs-Array – Fallback auf kapitel-extrahierte Songs.');
          ctx.warnings?.push({ key: 'job.warn.songsKonsolidierungDegraded' });
        }
        songs = buildFallbackSongs(chapterSongs, figNameToId, figNameToIdLower);
      }
      updateJob(jobId, { progress: PHASE_END.songsConsolidate });
    }
  }
  const songBestand = countSongsInDb(bookIdInt, email);
  if (_kollabiert(songBestand, songs.length)) {
    log.error(`Songs-Konsolidierung kollabiert: ${songs.length} Songs gegen ${songBestand} im Katalog – Bestand bleibt.`);
    ctx.warnings?.push({ key: 'job.warn.songsKollaps', params: { neu: songs.length, aktiv: songBestand } });
    return { songs: [], songsCount: songBestand };
  }
  saveSongsToDb(bookIdInt, songs, email, idMaps.chNameToId, idMaps.pageNameToIdByChapter);
  // Suchindex wie Figuren/Orte/Szenen (remap.js): Full-Replace der Songs des Buchs.
  searchIndex.removeKindForBook('song', bookIdInt);
  for (const r of listSongIdsForBook(bookIdInt)) searchIndex.upsertSong(r.id);
  log.info(`${songs.length} Songs gespeichert.`);
  return { songs };
}

/** Pre-Merge figurenKompakt aus chapterFiguren – für parallelen Orte-Call vor P2-Merge.
 *  Dedup nach ID (Reihenfolge: erstes Vorkommen gewinnt). */
function buildPrelimFigurenKompakt(chapterFiguren) {
  const seen = new Set();
  const list = [];
  for (const c of chapterFiguren) {
    for (const f of (c.figuren || [])) {
      if (!f?.id || seen.has(f.id)) continue;
      seen.add(f.id);
      list.push({ id: f.id, name: f.name, typ: f.typ || 'andere' });
    }
  }
  return list;
}

/** Baut den Orte-Konsolidierungs-Prompt und prüft vorab, ob die Antwort unter das
 *  Output-Cap passt. Geteilt von beiden Aufrufpfaden (seriell in runPhase3, parallel in
 *  runPhase3OrteCall), damit die Entscheidung nicht an zwei Orten auseinanderläuft.
 *  `fits: false` heisst: Truncation wäre sicher, und ihr Ergebnis ist ohnehin der
 *  regelbasierte Merge unten — den Call zu führen kostet nur Generierungszeit. */
function _orteKonsolPrompt(ctx, chapterOrte, figurenKompakt) {
  const { prompts, bookName, effectiveProvider } = ctx;
  const promptText = prompts.buildLocationsConsolidationPrompt(bookName, chapterOrte, figurenKompakt);
  const cap = komplettMaxTokens(effectiveProvider);
  const fit = consolidationFitsCap({
    promptText, dataText: JSON.stringify((chapterOrte || []).flatMap(c => c.orte || [])),
    charsPerToken: getContextConfigFor(effectiveProvider).charsPerToken, cap,
  });
  return { promptText, cap, fit };
}

/** Nur der Orte-Konso-AI-Call (Multi-Pass) – ohne DB-Save, ohne Progress-Update.
 *  Aufrufer löst figuren_namen → fig_id via runPhase3(opts.prefetchedOrteRaw) auf. */
async function runPhase3OrteCall(ctx, chapterOrte, figurenKompaktForPrompt) {
  const { jobId, call, tok, log, prompts, sys } = ctx;
  const { promptText, cap, fit } = _orteKonsolPrompt(ctx, chapterOrte, figurenKompaktForPrompt);
  if (!fit.fits) {
    log.warn(`Orte-Konsolidierung übersprungen – erwarteter Output ~${fit.estOut} Tokens über dem `
      + `Cap ${fit.cap} (Truncation wäre sicher). Fallback auf kapitel-extrahierte Orte. `
      + 'Abhilfe: ai.komplett.extract_max_tokens erhöhen.');
    ctx.warnings?.push({ key: 'job.warn.orteKonsolidierungDegraded' });
    return null;
  }
  try {
    return await call(jobId, tok,
      promptText,
      sys.SYSTEM_ORTE_BLOCKS,
      null, null,
      // Cap im maxTokens-Slot (siehe runPhase3).
      null, 0.2, cap, prompts.SCHEMA_ORTE_KONSOL, costTier(COST_LABEL.orte),
    );
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // Läuft parallel zu Phase 2 (Figuren) in Promise.all – ein Reject würde auch das
    // P2-Ergebnis verwerfen. null zurückgeben; runPhase3 fällt dann auf den regelbasierten
    // Orte-Merge zurück (kapitel-extrahierte Orte), statt den Job zu killen.
    log.warn(`Orte-Konsolidierung (parallel) fehlgeschlagen (${i18nErrText(e)}) – Fallback auf kapitel-extrahierte Orte.`);
    ctx.warnings?.push({ key: 'job.warn.orteKonsolidierungDegraded' });
    return null;
  }
}

module.exports = {
  runPhase3, runPhase3Songs, buildPrelimFigurenKompakt, runPhase3OrteCall, dedupeSongsWithinRun, buildFallbackSongs, remapSongFiguren,
  restoreOmittedOrte, restoreOmittedSongs,
  buildFallbackOrte, buildOrtNameLookup, ortAliasesFromSources,
};
