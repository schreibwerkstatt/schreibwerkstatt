'use strict';
// Pure Aggregation der Stil-Heatmap: Kapitel x Stil-Metrik aus `page_stats`.
// Bewusst ohne DB- und ohne HTTP-Bezug — die Zeilen liefert
// [db/style-stats.js](../db/style-stats.js), die Route in
// [routes/history/stats.js](../routes/history/stats.js) reicht sie nur durch.
// So ist die Aggregation ohne Express + SQLite testbar (Muster:
// lib/fehler-heatmap.js, Gegenstueck der Berechnung: lib/page-index.js).
//
// Warum das hier und nicht im Frontend liegt: die Rohform ist eine Zeile PRO
// SEITE mit Beispielsaetzen und der vollstaendigen Satzlaengen-Sequenz. Bei einem
// Buch mit tausenden Seiten sind das zweistellige Megabytes, aus denen ein
// Kapitel-Raster mit ein paar hundert Zeilen wird. Die Verdichtung gehoert an die
// Datenquelle; der Client bekommt das Raster.
//
// Die Beispielsaetze (`style_samples`) reist NICHT mit: gebraucht wird davon immer
// nur eine Zelle, naemlich die angeklickte. Dafuer gibt es `buildStilDetail`
// hinter einem eigenen Endpunkt.

const { computeRhythmBands, computeOpeners, computeChapterOpeners } = require('./stil-rhythmus');
const { percentileSorted } = require('./percentile');

const UNCAT = '__uncat__';

// Beispiel-Eimer, die eine Zelle aufklappen kann, und das Pro-Seite-Zaehlfeld,
// nach dem die Treffer sortiert werden. `repetition` liest stattdessen die
// Top-Woerter aus `repetition_data`.
const SAMPLE_BUCKETS = ['filler', 'passive', 'adverb', 'repetition'];
const COUNT_FIELD = { filler: 'filler_count', passive: 'passive_count', adverb: 'adverb_count' };

// Ich-Anteil im Erzaehltext: Pronomen-Gruppen aus lib/page-index.js#PRONOUN_GROUPS,
// nur der `narr`-Teil (Dialog zaehlt nicht — eine Er-Erzaehlung mit viel direkter
// Rede ist voller „ich"). 1. Person = Singular + Plural (Ich- und Wir-Erzaehler),
// 3. Person = er + sie. Mehrdeutigkeiten bleiben: „sie" deckt Singular UND Plural,
// „sein" auch das Verb — beides schiebt Richtung 3. Person, darum ist die Zahl ein
// Signal fuer einen Wechsel zwischen Kapiteln, keine Bestimmung der Perspektive.
const FIRST_PERSON_GROUPS = ['ich', 'wir'];
const THIRD_PERSON_GROUPS = ['er', 'sie_sg'];
// Unter dieser Zahl erzaehlender Pronomen (1. + 3. Person) ist der Anteil Rauschen —
// ein Kapitel aus drei Absaetzen Beschreibung kippt sonst mit jedem „mir" um.
const PERSPECTIVE_MIN_PRONOUNS = 20;

/** Ist `bucket` ein erlaubter Drilldown-Eimer? */
function isSampleBucket(bucket) {
  return SAMPLE_BUCKETS.includes(bucket);
}

// JSON-Spalte defensiv parsen: eine korrupte Zeile darf die ganze Karte nicht kippen.
function _parseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/** Rohzeile -> Objekt mit geparsten JSON-Spalten.
 *  `sentence_lens` steht in LESERICHTUNG; die Reihenfolge der Zeilen und die
 *  Reihenfolge im Array tragen zusammen den Rhythmus. */
function parseStyleRow(r) {
  const lens = _parseJson(r.sentence_lens);
  const openers = _parseJson(r.opener_counts);
  const pronouns = _parseJson(r.pronoun_counts);
  return {
    ...r,
    repetition_data: _parseJson(r.repetition_data),
    style_samples: _parseJson(r.style_samples),
    sentence_lens: Array.isArray(lens) ? lens : null,
    opener_counts: (openers && typeof openers === 'object') ? openers : null,
    pronoun_counts: (pronouns && typeof pronouns === 'object' && !Array.isArray(pronouns)) ? pronouns : null,
  };
}

// Gewichteter Mittelwert eines Felds ueber die Seiten einer Gruppe, Gewicht = Woerter.
function _wAvg(pages, field) {
  let num = 0, den = 0;
  for (const p of pages) {
    const v = p[field];
    if (v == null || !p.words) continue;
    num += v * p.words;
    den += p.words;
  }
  return den > 0 ? Math.round((num / den) * 10) / 10 : null;
}

/** Satzlaengen-P90 ueber eine Seitenmenge (Kapitel oder Buch).
 *
 *  Exakt: die `sentence_lens`-Sequenzen aller Seiten werden gepoolt und das
 *  Perzentil darueber genommen — dieselbe Definition wie der Seiten-P90
 *  (lib/percentile.js). Ein Mittel der Seiten-P90 ist das NICHT: zwei Seiten mit
 *  P90 10 und 40 ergeben nicht 25, sondern je nach Verteilung etwas zwischen den
 *  beiden.
 *
 *  Fallback NUR fuer Seiten ohne Sequenz (metrics_version < 7, bis zum naechsten
 *  Sync): deren gespeicherter Seiten-P90 geht wortgewichtet ein, und ist ein Teil
 *  der Seiten exakt, wird dessen Wert mit seinem Wortanteil dazugemischt. Das
 *  Ergebnis traegt dann `exact: false`.
 *
 *  Grenze: `sentence_lens` ist pro Seite auf MAX_SENTENCE_LENS gedeckelt
 *  (lib/page-index.js) — von einer Seite mit mehr Saetzen geht nur der Anfang ein. */
function _sentenceP90(pages) {
  const pooled = [];
  let exactWords = 0;
  const legacy = [];
  for (const p of pages) {
    if (Array.isArray(p.sentence_lens)) {
      for (const v of p.sentence_lens) pooled.push(v);
      exactWords += p.words || 0;
    } else if (p.sentence_len_p90 != null) {
      legacy.push(p);
    }
  }
  pooled.sort((a, b) => a - b);
  const exact = percentileSorted(pooled, 0.9);
  if (!legacy.length) return { value: exact, exact: true };
  const approx = _wAvg(legacy, 'sentence_len_p90');
  if (approx == null) return { value: exact, exact: true };
  if (exact == null) return { value: Math.round(approx), exact: false };
  const legacyWords = legacy.reduce((s, p) => s + (p.words || 0), 0);
  const den = exactWords + legacyWords;
  const mixed = den > 0 ? (exact * exactWords + approx * legacyWords) / den : exact;
  return { value: Math.round(mixed), exact: false };
}

/** Ich-Anteil (Prozent, eine Nachkommastelle) unter den erzaehlenden Pronomen der
 *  1. und 3. Person; `null` unter PERSPECTIVE_MIN_PRONOUNS oder ohne Pronomen-Daten. */
function _firstPersonShare(pages) {
  let first = 0, third = 0;
  for (const p of pages) {
    const pc = p.pronoun_counts;
    if (!pc) continue;
    for (const g of FIRST_PERSON_GROUPS) first += Number(pc[g]?.narr) || 0;
    for (const g of THIRD_PERSON_GROUPS) third += Number(pc[g]?.narr) || 0;
  }
  const total = first + third;
  if (total < PERSPECTIVE_MIN_PRONOUNS) return null;
  return Math.round((first / total) * 1000) / 10;
}

/** Baut die Kapitel-Zeilen der Heatmap.
 *  Gewichtete Durchschnitte ueber die Wortzahl — dominierende Seiten zaehlen mehr.
 *  `name` bleibt `null` fuer Seiten ohne Kapitel: das Label ist UI-Text. */
function _buildChapters(pages) {
  const groups = new Map();
  for (const p of pages) {
    const key = String(p.chapter_id ?? UNCAT);
    if (!groups.has(key)) groups.set(key, { key, name: p.chapter_name || null, pages: [] });
    groups.get(key).pages.push(p);
  }

  const out = [];
  for (const g of groups.values()) {
    let totalWords = 0, totalChars = 0, totalDialog = 0;
    let fillerSum = 0, passiveSum = 0, adverbSum = 0;
    let repNum = 0, repDen = 0;
    for (const p of g.pages) {
      totalWords  += p.words || 0;
      totalChars  += p.chars || 0;
      totalDialog += p.dialog_chars || 0;
      fillerSum   += p.filler_count || 0;
      passiveSum  += p.passive_count || 0;
      adverbSum   += p.adverb_count || 0;
      if (p.repetition_data?.score != null && p.words) {
        repNum += p.repetition_data.score * p.words;
        repDen += p.words;
      }
    }
    const p90 = _sentenceP90(g.pages);
    out.push({
      key: g.key,
      name: g.name,
      pageCount: g.pages.length,
      words: totalWords,
      filler_per1k:     totalWords > 0 ? Math.round((fillerSum  / totalWords) * 1000 * 10) / 10 : 0,
      passive_per1k:    totalWords > 0 ? Math.round((passiveSum / totalWords) * 1000 * 10) / 10 : 0,
      adverb_per1k:     totalWords > 0 ? Math.round((adverbSum  / totalWords) * 1000 * 10) / 10 : 0,
      avg_sentence_len: _wAvg(g.pages, 'avg_sentence_len'),
      sentence_len_p90: p90.value,
      // false = mindestens eine Seite ohne Satzlaengen-Sequenz, der Wert ist
      // dann teilweise das alte Mittel der Seiten-P90 (siehe _sentenceP90).
      sentence_len_p90_exact: p90.exact,
      dialog_ratio:     totalChars > 0 ? Math.round((totalDialog / totalChars) * 1000) / 10 : 0,
      repetition_score: repDen > 0 ? Math.round((repNum / repDen) * 10) / 10 : 0,
      lix:              _wAvg(g.pages, 'lix'),
      flesch_de:        _wAvg(g.pages, 'flesch_de'),
      first_person_share: _firstPersonShare(g.pages),
    });
  }
  return out;
}

/** Verdichtet die Seiten-Rows eines Buchs zur Antwort der Stil-Karte.
 *
 *  @param rows           Rohzeilen aus db/style-stats.js#loadStyleRows
 *  @param metricsVersion aktuelle lib/page-index.js#METRICS_VERSION
 *  @returns Objekt mit chapters, book (Buch-P90), rhythm, openers,
 *           chapterOpeners (Top 10 je Kapitel), needsSync, metricsVersion,
 *           lastUpdated und pageCount.
 */
function buildStilHeatmap({ rows = [], metricsVersion = 0 } = {}) {
  const pages = rows.map(parseStyleRow);

  // „Unvollstaendig" heisst: die Seite hat Text, wurde aber nie oder unter einer
  // aelteren Metrik-Version gerechnet. Der Client wuerde sonst dauerhaft alte
  // Zahlen zeigen, ohne dass irgendwo ein Fehler erscheint.
  // Ein fehlender LIX-Wert allein ist KEIN Grund: eine Seite ohne zaehlbaren Satz
  // (nur Zahlen, Kuerzel, eine Tabelle) hat auch nach dem Rechnen keinen — als
  // Ausloeser liess sie die Karte bei jedem Oeffnen das ganze Buch neu rechnen.
  // `metrics_version` setzt allein der Stil-Index (lib/page-index.js); eine Zeile,
  // die nur der Umfangs-Pfad geschrieben hat, faellt damit weiterhin auf.
  const needsSync = pages.length === 0
    || pages.some(p => (p.words > 0) && (p.metrics_version ?? 0) < metricsVersion);

  let lastUpdated = null;
  for (const p of pages) {
    if (p.cached_at && (!lastUpdated || p.cached_at > lastUpdated)) lastUpdated = p.cached_at;
  }

  const bookP90 = _sentenceP90(pages);
  return {
    chapters: _buildChapters(pages),
    book: { sentence_len_p90: bookP90.value, sentence_len_p90_exact: bookP90.exact },
    rhythm: computeRhythmBands(pages),
    openers: computeOpeners(pages),
    chapterOpeners: computeChapterOpeners(pages),
    // Mindestzahl hinter `first_person_share` — fuer den Spalten-Tooltip, damit
    // das Frontend keine Kopie der Schwelle haelt.
    perspectiveMinPronouns: PERSPECTIVE_MIN_PRONOUNS,
    needsSync,
    metricsVersion,
    lastUpdated,
    pageCount: pages.length,
  };
}

/** Drilldown einer einzelnen Zelle: die Treffer-Beispiele der Seiten EINES Kapitels.
 *  `rows` sind bereits auf das Kapitel eingeschraenkt (db/style-stats.js#loadStyleSamples).
 *  Sortiert nach Trefferzahl absteigend — die dichteste Seite zuerst. */
function buildStilDetail({ rows = [], bucket } = {}) {
  if (!isSampleBucket(bucket)) return { entries: [] };
  const entries = [];
  for (const r of rows) {
    const p = parseStyleRow(r);
    if (bucket === 'repetition') {
      const top = p.repetition_data?.top || [];
      if (!top.length) continue;
      entries.push({
        page_id: p.page_id,
        page_name: p.page_name || String(p.page_id),
        count: top.reduce((s, x) => s + (x.count || 0), 0),
        words: top.map(x => ({ token: x.word, count: x.count })),
      });
    } else {
      const samples = p.style_samples?.[bucket] || [];
      if (!samples.length) continue;
      const countField = COUNT_FIELD[bucket];
      entries.push({
        page_id: p.page_id,
        page_name: p.page_name || String(p.page_id),
        count: (countField && p[countField]) || samples.length,
        // Nach Token gruppiert, damit jedes Wort im Panel einmal als Plakette
        // erscheint und die Beispielsaetze darunter eingerueckt stehen.
        tokens: _groupByToken(samples),
      });
    }
  }
  entries.sort((a, b) => b.count - a.count);
  return { entries };
}

// [{token, sentence}] -> [{token, sentences: [...]}], Reihenfolge des ersten Auftretens.
function _groupByToken(samples) {
  const groups = [];
  const byToken = new Map();
  for (const s of samples || []) {
    const token = s.token || '';
    let g = byToken.get(token);
    if (!g) { g = { token, sentences: [] }; byToken.set(token, g); groups.push(g); }
    g.sentences.push(s.sentence);
  }
  return groups;
}

module.exports = {
  buildStilHeatmap,
  buildStilDetail,
  parseStyleRow,
  isSampleBucket,
  SAMPLE_BUCKETS,
  UNCAT,
  PERSPECTIVE_MIN_PRONOUNS,
};
