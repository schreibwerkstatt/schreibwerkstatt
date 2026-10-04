'use strict';
// Geteilte Bausteine der beiden Kontinuitäts-tragenden Jobs (Komplettanalyse +
// Standalone-Kontinuitätscheck): Verify-Stufe (False-Positive-Filter gegen den
// Originaltext), Anachronismus-Datenbasis, Per-Job-Claude-Overrides.

const { db, getBookSettings } = require('../../../db/schema');
const appSettings = require('../../../lib/app-settings');
const { providerClass } = require('../../../lib/ai');
const { updateJob, settledAll, jobAbortControllers, i18nError } = require('../shared');
const { _stelleQuote, _refToString } = require('./utils');
const { COST_LABEL, costTier } = require('./cost-labels');
const rerank = require('../../../lib/rerank');
const retrieval = require('../../../lib/semantic-retrieval');
const { bestLivePassage } = require('../../../lib/live-passage');
const { buildPageIndex, buildFactIndex, locateStelle, excerptOnPage } = require('../../../lib/continuity-evidence');

// ── Verify-Stufe für den Multi-Pass-Kontinuitätscheck ────────────────────────
// Der Fakten-basierte Check sieht nur extrahierte Fakten, nicht den Volltext –
// auflösender Kontext (Rückblende, Ironie, Konjunktiv, indirekte Rede) ist dort
// schon weg und erzeugt systematisch False-Positives. Pro gemeldetem Problem
// laden wir die Original-Textstellen nach und lassen das Modell den Widerspruch
// mit echtem Kontext bestätigen oder verwerfen. Single-Pass braucht das nicht
// (hat den Volltext bereits beim Check).
const _VERIFY_RADIUS = 1500;
// Ausgabe-Deckel des Verify-Urteils. Adaptives Thinking zählt gegen max_tokens — ein
// knapper Deckel schneidet das Urteil ab, der Befund bliebe dann ungeprüft (keep).
// Effort 'low' hält das Denken kurz; ausserhalb Claudes ignorieren die Provider den
// Effort (lib/ai/core.js), auf Modellen ohne Effort klemmt _claudeOutputConfigParams.
const _VERIFY_MAX_TOKENS = 4000;
const _VERIFY_EFFORT = 'low';

// Textfenster rund um das Zitat aus den im Problem referenzierten Kapiteln.
// Whitespace-normalisiert (matcht den Single-Pass-/Fakten-Textfluss); findet das
// Zitat und schneidet ±_VERIFY_RADIUS Zeichen aus. Rückgabe { text, located }:
// located=true nur bei wörtlichem Zitat-Treffer, sonst Kapitel-Anfang als
// Notnagel (located=false) — das Signal steuert den semantischen Fallback unten.
function _verifyExcerpt(groups, groupOrder, kapitelNames, quote) {
  const texts = [];
  for (const key of groupOrder) {
    const g = groups.get(key);
    if (kapitelNames.includes(g.name)) texts.push(g.pages.map(p => p.text).join('\n'));
  }
  if (!texts.length) return { text: '', located: false };
  const full = texts.join('\n\n').replace(/\s+/g, ' ');
  if (quote) {
    const needle = quote.replace(/\s+/g, ' ').slice(0, 40);
    const idx = full.indexOf(needle);
    if (idx >= 0) return { text: full.slice(Math.max(0, idx - _VERIFY_RADIUS), Math.min(full.length, idx + needle.length + _VERIFY_RADIUS)), located: true };
  }
  return { text: full.slice(0, _VERIFY_RADIUS * 2), located: false };
}

// Semantischer Beleg-Fallback: findet die wörtliche Suche das Zitat nicht
// (Paraphrase, vom Modell rekonstruiertes Zitat, Umformulierung desselben Fakts),
// sucht die Freitext-Pipeline (`semanticQuery`: Cosinus + FTS-Hybrid, der auch
// fast-wörtliche Zitate trägt, + optional Rerank) die nächste Passage — aber nur
// auf den Seiten der Kapitel, die der Befund nennt, und nur oberhalb einer
// Konfidenz-Schwelle. Ein unverwandter Absatz aus einem fremden Kapitel wäre für
// die Verify-Stufe ein falscher Beleg, der einen echten Widerspruch „auflöst".
//
// Der Chunk ist nur Wegweiser: der Ausschnitt kommt aus dem LIVE-Text der Seite
// (`pageTexts`, derselbe Stand wie der Keyword-Pfad), nicht aus dem Index.
// Rückgabe { text, located: true } oder null (nichts Belastbares gefunden).
// Rein rückwärtsgewandt; Backend-Fehler sind non-fatal (null), Abbruch nicht.
const _SEMANTIC_VERIFY_TOPK = 20;
function _verifyFloors() {
  const minCos = Number(appSettings.get('embed.min_score'));
  const rr = rerank.isEnabled() ? rerank.getConfig() : null;
  return {
    minCos: Number.isFinite(minCos) && minCos > 0 ? minCos : 0,
    minRerank: rr && rr.minScore > 0 ? rr.minScore : null,
  };
}
async function _semanticExcerpt(bookId, query, pageTexts, signal) {
  const q = String(query || '').trim();
  if (!q || !pageTexts || !pageTexts.size) return null;
  let hits;
  try {
    hits = await retrieval.semanticQuery(bookId, q, { kinds: ['page'], topK: _SEMANTIC_VERIFY_TOPK, signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    return null; // Backend down/nicht erreichbar → keyword-Pfad behalten
  }
  const { minCos, minRerank } = _verifyFloors();
  for (const h of (hits || [])) {
    if (h.kind !== 'page') continue;
    const live = pageTexts.get(Number(h.entity_id));
    if (live == null) continue;                      // Seite ausserhalb der Befund-Kapitel
    if (h.semScore == null || h.semScore < minCos) continue;
    if (minRerank != null && !(h.score >= minRerank)) continue;
    const ex = bestLivePassage(live, h.text, { maxChars: _VERIFY_RADIUS * 2 });
    if (ex && ex.text) return { text: ex.text, located: true };
  }
  return null;
}

// Live-Seitentexte (id → Text) der Kapitel, die ein Befund nennt — Suchraum und
// Textquelle des semantischen Fallbacks.
function _chapterPageTexts(groups, groupOrder, kapitelNames) {
  const out = new Map();
  for (const key of groupOrder) {
    const g = groups.get(key);
    if (!g || !kapitelNames.includes(g.name)) continue;
    for (const pg of g.pages || []) if (pg.id != null && pg.text) out.set(Number(pg.id), pg.text);
  }
  return out;
}

// Filtert die Probleme des Fakten-Checks: verwirft nur explizit als unecht
// eingestufte (bestaetigt=false); nicht lokalisierbare/fehlgeschlagene bleiben
// konservativ erhalten. Nur Cloud-Klasse (lokale Provider: zu kleines Kontextfenster
// für zuverlässige Verify-Urteile, Mutex serialisiert zudem jeden Call).
// `chapterFacts` (Multi-Pass-Fakten mit Seitennamen) + `ctx.pageContents`: das Modell
// zitiert im Multi-Pass Fakt-Aussagen, keine Buchsätze — der wörtliche Treffer bleibt
// darum meist aus. Der zitierte Fakt trägt aber seine Seite; deren Text ist der
// richtige Beleg (lib/continuity-evidence.js), noch vor dem semantischen Fallback.
async function verifyKontinuitaetProbleme(ctx, result, fromPct, toPct, { chapterFacts = null } = {}) {
  const { call, prompts, sys, jobId, tok, bookName, groups, groupOrder, log, bookIdInt } = ctx;
  const probleme = Array.isArray(result?.probleme) ? result.probleme : [];
  if (!probleme.length) return result;
  const pageIdx = buildPageIndex(ctx.pageContents);
  const factIdx = chapterFacts ? buildFactIndex(chapterFacts) : null;
  const viaFact = (ex, stelle, quote, kap) => {
    if (ex.located || !factIdx?.length || !pageIdx.length) return ex;
    const page = locateStelle(_refToString(stelle) || '', quote, pageIdx, { kapitel: kap, facts: factIdx });
    return page ? { text: excerptOnPage(page, quote, _VERIFY_RADIUS), located: true } : ex;
  };
  updateJob(jobId, { progress: fromPct, statusText: 'job.phase.verifyContradictions' });
  // Semantischer Beleg-Fallback nur, wenn das Embed-Backend konfiguriert ist UND
  // dieses Buch einen vollständigen Index unter dem aktiven Modell hat. Sonst
  // reiner keyword-Pfad.
  const semanticOn = bookIdInt != null && retrieval.indexReady(bookIdInt);
  const signal = jobAbortControllers.get(jobId)?.signal;
  // Concurrency-Cap wie Phase 1 (settledAll + ai.claude.phase1_concurrency, Warmup gegen den
  // gecachten Buchtext-Block): bei 40-60 Befunden würde Promise.all sonst Dutzende Claude-Calls
  // gleichzeitig feuern → TPM-Burst (429/overloaded, auch auf andere Pipeline-Calls).
  const claudeConcurrency = Math.max(1, parseInt(appSettings.get('ai.claude.phase1_concurrency'), 10) || 4);
  const settled = await settledAll(probleme.map((p) => async () => {
    const kap = Array.isArray(p.kapitel) ? p.kapitel : [];
    if (!kap.length) return { p, keep: true };
    const qA = _stelleQuote(p.stelle_a);
    const qB = _stelleQuote(p.stelle_b);
    let exA = viaFact(_verifyExcerpt(groups, groupOrder, kap, qA), p.stelle_a, qA, kap);
    let exB = viaFact(_verifyExcerpt(groups, groupOrder, kap, qB), p.stelle_b, qB, kap);
    // Zitat wörtlich nicht gefunden → semantisch die nächste Passage in den
    // Befund-Kapiteln holen (Paraphrase). Query = Zitat, sonst der Stellen-Text.
    // Findet auch die Semantik nichts Belastbares, bekommt die Verify-Stufe für
    // diese Seite KEINEN Ausschnitt („im Text nicht gefunden") statt des
    // Kapitel-Anfangs — der wäre ein unverwandter Pseudo-Beleg.
    if (semanticOn && (!exA.located || !exB.located)) {
      const pageTexts = _chapterPageTexts(groups, groupOrder, kap);
      if (!exA.located) {
        const qa = qA || _refToString(p.stelle_a);
        exA = (qa && await _semanticExcerpt(bookIdInt, qa, pageTexts, signal)) || { text: '', located: false };
      }
      if (!exB.located) {
        const qb = qB || _refToString(p.stelle_b);
        exB = (qb && await _semanticExcerpt(bookIdInt, qb, pageTexts, signal)) || { text: '', located: false };
      }
    }
    if (!exA.text && !exB.text) return { p, keep: true };
    try {
      const v = await call(jobId, tok,
        prompts.buildKontinuitaetVerifyPrompt(bookName, p, exA.text, exB.text),
        sys.SYSTEM_KONTINUITAET_BLOCKS, null, null, 400, 0.3, _VERIFY_MAX_TOKENS, prompts.SCHEMA_KONTINUITAET_VERIFY,
        { ...costTier(COST_LABEL.kontinuitaet), effort: _VERIFY_EFFORT });
      const keep = v?.bestaetigt !== false;
      if (!keep) {
        const grund = String(v?.grund || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        log.info(`Kontinuität Verify verwirft «${String(p.beschreibung || '').slice(0, 120)}»: ${grund || '(kein Grund angegeben)'}`);
      }
      return { p, keep };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      log.warn(`Kontinuität Verify übersprungen: ${e.message}`);
      return { p, keep: true };
    }
  }), { concurrency: claudeConcurrency, warmup: true });
  // Abbruch (AbortError in einem Verify-Call) muss den Job stoppen — settledAll fängt
  // Rejects ab, darum gezielt re-raisen. Übrige Rejects konservativ als keep behandeln.
  const aborted = settled.find(r => r.status === 'rejected' && r.reason?.name === 'AbortError');
  if (aborted) throw aborted.reason;
  const verdicts = settled.map((r, i) => r.status === 'fulfilled' ? r.value : { p: probleme[i], keep: true });
  const kept = verdicts.filter(v => v.keep).map(v => v.p);
  const dropped = probleme.length - kept.length;
  if (dropped > 0) log.info(`Kontinuität Verify: ${dropped}/${probleme.length} False-Positive(s) verworfen.`);
  updateJob(jobId, { progress: toPct });
  return { ...result, probleme: kept };
}

// ── Anachronismus-Datenbasis für die Kontinuitätsprüfung ─────────────────────
// Nur bei Romanen mit echter Zeitlinie (book_settings.zeitlinie_real). Liefert die
// globale Erzählzeit-Spanne aus sicher datierten Figuren-/Zeitstrahl-Ereignissen plus
// die im Buch erwähnten Songs und Welt-Fakten (Technik/Historie/Ereignis/Kultur). Jeder
// Eintrag bekommt – soweit ableitbar – das Erzähljahr SEINER Erwähnung: Entität → Kapitel
// (song_chapters / world_fact_chapters) → in diesem Kapitel datierte Ereignisse. So
// vergleicht das Modell das reale Entstehungs-/Veröffentlichungsjahr (Eigenwissen) gegen
// die lokale Szenen-Zeit statt nur gegen die Gesamtspanne (präzise bei Rückblenden/
// Mehr-Epochen-Büchern). Auch Single-Pass-Fakten haben einen Kapitel-Link, weil
// saveFaktenToDb dort über den Seitennamen (f.seite → page → chapter) backfillt. Fakten
// ohne auflösbaren Kapitel-Link oder in undatierten Kapiteln tragen kein Per-Eintrag-Jahr
// → Fallback auf die Gesamtspanne.
// null, wenn die Zeitlinie aus ist, keine datierten Ereignisse vorliegen oder es nichts
// Prüfbares gibt → der Prompt-Builder lässt die Anachronismus-Prüfung dann ganz weg.
// Jahres-Spannen kommen kanonisch aus dem konsolidierten zeitstrahl_events (Fallback
// figure_events, wenn noch nicht konsolidiert). Lesepfad-sicher in beiden Aufrufern: der
// Komplett-Job ruft erst nach der Zeitstrahl-Konsolidierung (P6) auf, der Standalone-
// Kontinuitätscheck gegen einen früher konsolidierten Zeitstrahl; songs (runPhase3Songs)
// und world_facts (saveFaktenToDb) sind vor P8 ebenfalls persistiert.
function buildAnachronismusData(bookIdInt, email) {
  const { zeitlinie_real } = getBookSettings(bookIdInt, email);
  if (!zeitlinie_real) return null;
  // Kanonische Quelle ist der konsolidierte Zeitstrahl (zeitstrahl_events) — dieselbe
  // Menge, aus der Ereignisse-Karte und Figuren-Jahr ableiten. Nur wenn (noch) kein
  // Zeitstrahl konsolidiert wurde, Fallback auf die rohen figure_events, damit ein reiner
  // Kontinuitäts-Lauf ohne vorherige Komplettanalyse nicht leer ausgeht.
  const hasZeitstrahl = !!db.prepare(
    'SELECT 1 FROM zeitstrahl_events WHERE book_id = ? AND user_email IS ? LIMIT 1'
  ).get(bookIdInt, email);
  // Globale Spanne (Header + Fallback) aus allen datierten Ereignissen – auch ohne Kapitel-Link.
  const yearRow = hasZeitstrahl
    ? db.prepare(`
        SELECT MIN(datum_year) AS minY, MAX(COALESCE(datum_ende_year, datum_year)) AS maxY
          FROM zeitstrahl_events
         WHERE book_id = ? AND user_email IS ? AND datum_unsicher = 0 AND datum_year IS NOT NULL
      `).get(bookIdInt, email)
    : db.prepare(`
        SELECT MIN(fe.datum_year) AS minY, MAX(COALESCE(fe.datum_ende_year, fe.datum_year)) AS maxY
          FROM figure_events fe JOIN figures f ON f.id = fe.figure_id
         WHERE f.book_id = ? AND f.user_email IS ? AND fe.datum_unsicher = 0 AND fe.datum_year IS NOT NULL
      `).get(bookIdInt, email);
  if (!yearRow || yearRow.minY == null) return null;
  const minYear = yearRow.minY, maxYear = yearRow.maxY;
  // Kapitel → {minY, maxY} aus den datierten Ereignissen dieses Kapitels (Per-Eintrag-Jahr).
  const chapterRows = hasZeitstrahl
    ? db.prepare(`
        SELECT zec.chapter_id AS chapter_id, MIN(ze.datum_year) AS minY,
               MAX(COALESCE(ze.datum_ende_year, ze.datum_year)) AS maxY
          FROM zeitstrahl_events ze JOIN zeitstrahl_event_chapters zec ON zec.event_id = ze.id
         WHERE ze.book_id = ? AND ze.user_email IS ? AND ze.datum_unsicher = 0
           AND ze.datum_year IS NOT NULL AND zec.chapter_id IS NOT NULL
         GROUP BY zec.chapter_id
      `).all(bookIdInt, email)
    : db.prepare(`
        SELECT fe.chapter_id AS chapter_id, MIN(fe.datum_year) AS minY,
               MAX(COALESCE(fe.datum_ende_year, fe.datum_year)) AS maxY
          FROM figure_events fe JOIN figures f ON f.id = fe.figure_id
         WHERE f.book_id = ? AND f.user_email IS ? AND fe.datum_unsicher = 0
           AND fe.datum_year IS NOT NULL AND fe.chapter_id IS NOT NULL
         GROUP BY fe.chapter_id
      `).all(bookIdInt, email);
  const chMap = new Map(chapterRows.map(r => [r.chapter_id, { minY: r.minY, maxY: r.maxY }]));

  // Erzähljahr-Spanne über eine Menge Kapitel-IDs → "1985" | "1985–1986" | null.
  const jahrFor = (chapterIds) => {
    let lo = null, hi = null;
    for (const cid of chapterIds) {
      const ce = chMap.get(cid);
      if (!ce) continue;
      if (lo == null || ce.minY < lo) lo = ce.minY;
      if (hi == null || ce.maxY > hi) hi = ce.maxY;
    }
    if (lo == null) return null;
    return lo === hi ? String(lo) : `${lo}–${hi}`;
  };
  // Mehrere Bridge-Zeilen pro Entität (1 je Kapitel) zu {…, chapterIds[]} gruppieren.
  const groupByEntity = (rows, baseOf) => {
    const byId = new Map();
    for (const r of rows) {
      let e = byId.get(r.id);
      if (!e) { e = { ...baseOf(r), chapterIds: [] }; byId.set(r.id, e); }
      if (r.chapter_id != null) e.chapterIds.push(r.chapter_id);
    }
    return [...byId.values()];
  };

  const songRows = db.prepare(`
    SELECT s.id, s.titel, s.interpret, sc.chapter_id
      FROM songs s LEFT JOIN song_chapters sc ON sc.song_id = s.id
     WHERE s.book_id = ? AND s.user_email IS ? ORDER BY s.sort_order
  `).all(bookIdInt, email);
  const songs = groupByEntity(songRows, s => ({ titel: s.titel, interpret: s.interpret || '' }))
    .map(s => ({ titel: s.titel, interpret: s.interpret, jahr: jahrFor(s.chapterIds) }));

  const factRows = db.prepare(`
    SELECT wf.id, wf.kategorie, wf.subjekt, wf.fakt, wfc.chapter_id
      FROM world_facts wf LEFT JOIN world_fact_chapters wfc ON wfc.fact_id = wf.id
     WHERE wf.book_id = ? AND wf.user_email IS ?
       AND wf.kategorie IN ('technik','historie','ereignis','kultur')
     ORDER BY wf.sort_order
  `).all(bookIdInt, email);
  const facts = groupByEntity(factRows, f => ({
    kategorie: f.kategorie,
    text: `${f.subjekt ? f.subjekt + ': ' : ''}${f.fakt}`,
  })).map(f => ({ kategorie: f.kategorie, text: f.text, jahr: jahrFor(f.chapterIds) }));
  const technik = facts.filter(f => f.kategorie === 'technik').map(({ text, jahr }) => ({ text, jahr }));
  const ereignisse = facts.filter(f => f.kategorie !== 'technik').map(({ text, jahr }) => ({ text, jahr }));

  if (!songs.length && !technik.length && !ereignisse.length) return null;
  return { minYear, maxYear, songs, technik, ereignisse };
}

// Attribut-Widerspruchs-Detektor (F4): ./attribute-check.js (hier re-exportiert).
const { buildAttributeContradictions, runAttributeContradictionCheck } = require('./attribute-check');

// ── Remap-Rescue: unauflösbare Figuren-Klarnamen dem Katalog zuordnen ─────────
// remapSzenen/remapAssignments verwerfen Figuren-Klarnamen aus Szenen/Events, die sich weder
// exakt noch per lowercase/Token-Fallback einem konsolidierten Figur-Eintrag zuordnen lassen
// (Spitznamen, Teilnamen, Epitheta, Schreibvarianten). Bevor sie gedroppt werden, mappt ein
// billiger Auflösungs-Call (Kandidaten + Katalognamen → Zuordnung oder «») sie – gefundene
// Treffer werden als lowercase-Aliase in figNameToIdLower eingespeist, sodass der anschliessende
// Remap sie auflöst statt Szenen-Figuren-Links / Event-Assignments zu verlieren. Nur
// Cloud-Klasse (der Call urteilt über Namensvarianten und braucht ein faehiges Modell,
// keine Anthropic-API-Faehigkeit — SSoT lib/ai/config.js#providerClass),
// nur wenn es überhaupt unauflösbare Namen gibt. Non-fatal (AbortError propagiert). Mutiert
// figNameToIdLower in place; gibt die Anzahl neu aufgelöster Namen zurück.
async function resolveRemapNames(ctx, { chapterSzenen, chapterAssignments, figuren, figNameToId, figNameToIdLower }) {
  const { call, prompts, sys, jobId, tok, bookName, log, effectiveProvider } = ctx;
  if (providerClass(effectiveProvider) !== 'cloud') return 0;
  if (appSettings.get('ai.komplett.remap_rescue') === false) return 0;

  const isResolved = (name) => !name || !!(figNameToId[name] || figNameToIdLower[name.toLowerCase()]);
  const unknown = new Map(); // lowerKey → Anzeige-Name
  const add = (raw) => {
    const name = _refToString(raw);
    if (!name || isResolved(name)) return;
    const k = name.toLowerCase();
    if (!unknown.has(k)) unknown.set(k, name);
  };
  for (const { szenen } of (chapterSzenen || []))
    for (const s of (szenen || []))
      for (const n of (s?.figuren_namen || [])) add(n);
  for (const { assignments } of (chapterAssignments || []))
    for (const a of (assignments || [])) add(a?.figur_name);

  const unknownList = [...unknown.values()];
  const catalogNames = (figuren || []).map(f => f.name).filter(Boolean);
  if (!unknownList.length || !catalogNames.length) return 0;

  updateJob(jobId, { statusText: 'job.phase.resolveNames' });
  let res;
  try {
    res = await call(jobId, tok,
      prompts.buildNameResolutionPrompt(bookName, unknownList, catalogNames),
      sys.SYSTEM_FIGUREN_BLOCKS, null, null, 800, 0.2, null, prompts.SCHEMA_NAME_RESOLUTION,
      costTier(COST_LABEL.match));
    // Pflichtfeld: ohne `zuordnungen`-Array hat das Modell nicht wie verlangt geantwortet
    // — als Fehler melden (gleicher non-fataler Ausgang unten), nicht still als
    // «nichts zuzuordnen» weiterlaufen.
    if (!Array.isArray(res?.zuordnungen)) throw i18nError('job.error.nameResolutionMissing');
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    log.warn(`Remap-Rescue Namensauflösung fehlgeschlagen (ignoriert): ${e.message}`);
    return 0;
  }
  const catalogByLower = new Map((figuren || []).map(f => [String(f.name || '').toLowerCase(), f.id]));
  let added = 0;
  for (const z of res.zuordnungen) {
    const name = _refToString(z?.name);
    const treffer = _refToString(z?.treffer);
    if (!name || !treffer) continue;
    const id = figNameToId[treffer] || figNameToIdLower[treffer.toLowerCase()] || catalogByLower.get(treffer.toLowerCase());
    if (!id) continue;
    const lk = name.toLowerCase();
    if (!figNameToIdLower[lk]) { figNameToIdLower[lk] = id; added++; }
  }
  if (added) log.info(`Remap-Rescue: ${added}/${unknownList.length} unauflösbare Namen dem Katalog zugeordnet.`);
  return added;
}

// ── Per-Job-Overrides für die Komplettanalyse-Familie ─────────────────────────
// Modell, Kontextfenster, Output-Cap und Hard-Timeout dürfen für die Analyse eigenständig
// vom globalen `ai.<provider>.*` abweichen (z.B. Opus 4.8 mit 128K Output + längerem
// Timeout für die gründlichere Extraktion, während global Sonnet 4.6 / 64K / 10min fürs
// Lektorat läuft). Leer/0 = folgt global. Als provider-skopierter Bag über den ALS-Context
// an lib/ai gereicht (config.js#jobOverride) → greift für alle Calls dieses Jobs, ohne
// globale Calls zu beeinflussen.
//
// GILT FÜR JEDEN PROVIDER, nicht nur Claude: ein gehostetes Frontier-Modell über
// openai-compat hat dieselbe Trennung zwischen Alltags- und Analyse-Konfiguration, und
// die Analyse fuhr dort sonst zwangsläufig mit dem Lektorat-Fenster. `effort` ist der
// einzige claude-exklusive Teil (Anthropic-Parameter) — für andere Provider existiert
// der Key nicht und der Wert bleibt leer.
//
// Per-Call-Timeout-Default für die Komplettanalyse, wenn ein eigenes Komplett-Profil
// (Modell/Kontext/Output) gesetzt ist, aber kein expliziter timeout_ms.komplett: 30 Min.
// Begründung: (a) die globalen 10 Min sind für Single-Pass-Calls über ein ganzes Buch
// zu knapp; (b) 30 Min < 1h-Prompt-Cache-TTL — aufeinanderfolgende Claude-Calls (P1…P8,
// alle auf demselben gecachten 1h-Buchtext-Block) stossen den Cache so stets vor Ablauf
// neu an.
const KOMPLETT_DEFAULT_TIMEOUT_MS = 1800000; // 30 min

// Provider mit eigenem Komplett-Override-Satz. Ollama fehlt bewusst: dort ist das
// Modell an das lokal geladene Gewicht gebunden, ein zweites Analyse-Modell danebenzu-
// stellen hiesse VRAM-Tausch mitten im Job.
const KOMPLETT_OVERRIDE_PROVIDERS = new Set(['claude', 'openai-compat']);

function _komplettAiOverrides(effectiveProvider) {
  const p = effectiveProvider;
  if (!KOMPLETT_OVERRIDE_PROVIDERS.has(p)) return null;
  const model = String(appSettings.get(`ai.${p}.model.komplett`) || '').trim();
  const contextWindow = parseInt(appSettings.get(`ai.${p}.context_window.komplett`), 10) || 0;
  const maxTokensOut = parseInt(appSettings.get(`ai.${p}.max_tokens_out.komplett`), 10) || 0;
  const timeoutMs = parseInt(appSettings.get(`ai.${p}.timeout_ms.komplett`), 10) || 0;
  const effort = p === 'claude'
    ? String(appSettings.get('ai.claude.effort.komplett') || '').trim().toLowerCase()
    : '';
  const bag = { provider: p };
  if (model) bag.model = model;
  if (contextWindow > 0) bag.contextWindow = contextWindow;
  if (maxTokensOut > 0) bag.maxTokensOut = maxTokensOut;
  // Effort greift für ALLE Claude-Calls des Jobs (P1–P8 + Kontinuität); ungültige Werte
  // mappt _resolveClaudeEffort still auf null. Auf Nicht-Effort-Modellen (Sonnet 4.5/Haiku)
  // klemmt _claudeOutputConfigParams selbst (kein 400).
  if (effort) bag.effort = effort;
  // Eigenes Komplett-Profil aktiv? Dann den Timeout-Default greifen lassen (nie unter den
  // expliziten globalen Wert senken). Ohne Profil bleibt es beim globalen Timeout.
  const hasKomplettProfile = !!(model || contextWindow > 0 || maxTokensOut > 0);
  if (timeoutMs > 0) {
    bag.timeoutMs = timeoutMs;
  } else if (hasKomplettProfile) {
    const globalTimeoutMs = parseInt(appSettings.get(`ai.${p}.timeout_ms`), 10) || 600000;
    bag.timeoutMs = Math.max(KOMPLETT_DEFAULT_TIMEOUT_MS, globalTimeoutMs);
  }
  // Nur `provider` im Bag = nichts überschrieben → gar keinen Bag setzen.
  return Object.keys(bag).length > 1 ? { aiJob: bag } : null;
}

module.exports = {
  _semanticExcerpt,
  _verifyExcerpt, verifyKontinuitaetProbleme,
  buildAnachronismusData, _komplettAiOverrides,
  buildAttributeContradictions, runAttributeContradictionCheck,
  resolveRemapNames,
};
