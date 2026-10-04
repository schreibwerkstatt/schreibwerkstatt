'use strict';
// Pure Aggregation der Fehler-Heatmap: Fehler-Typen × Kapitel aus den
// Lektorats-Laeufen eines Buchs. Bewusst ohne DB- und ohne HTTP-Bezug — die
// Zeilen liefert [db/lektorat-heatmap.js](../db/lektorat-heatmap.js), die
// Route in [routes/history/heatmap.js](../routes/history/heatmap.js) reicht
// sie nur durch. So ist die Aggregation ohne Express + SQLite testbar
// (Gegenstueck: lib/page-index.js).
//
// Drei Modi (open | applied | all) entscheiden, WAS als Fehler zaehlt. Die
// Regel dazu steht in [lib/lektorat-findings.js](./lektorat-findings.js) —
// derselbe Kern rechnet die Fassungs-Kennzahl des Fehlerdichte-Trends
// (lib/lektorat-metrics.js), damit Heatmap und Trend nie auseinanderlaufen.
//
// Die Dichte `per1k` rechnet gegen `words_checked` (Woerter der GEPRUEFTEN
// Seiten), nicht gegen `words` (alle Seiten des Kapitels). Sonst waere die Rate
// bei Teilabdeckung systematisch zu niedrig — ungeprueft ist nicht fehlerfrei,
// und ein halb geprueftes Kapitel saehe halb so dicht aus wie es ist. `words`
// bleibt daneben stehen: es ist der Umfang des Kapitels, keine Bezugsgroesse.

const { pageFindings } = require('./lektorat-findings');

const MODES = ['open', 'applied', 'all'];
const UNCAT = '__uncat__';
// Pro Typ und Seite hoechstens so viele Beispiel-Findings ins Detail-Panel.
const MAX_SAMPLES = 3;

// Einen Modus-String auf einen erlaubten Wert normalisieren.
function normalizeMode(raw) {
  return MODES.includes(raw) ? raw : 'open';
}

// page_id -> Checks mit Annahmen (Reihenfolge der DB: aelteste zuerst).
function _appliedRowsByPage(appliedRows) {
  const out = new Map();
  for (const row of appliedRows) {
    let arr = out.get(row.page_id);
    if (!arr) { arr = []; out.set(row.page_id, arr); }
    arr.push(row);
  }
  return out;
}

// Typ-Zaehler + Beispiel-Findings einer einzelnen Seite.
function _perPage(effective) {
  const counts = {};
  const samples = {};
  for (const e of effective) {
    const typ = e?.typ;
    if (!typ) continue;
    counts[typ] = (counts[typ] || 0) + 1;
    if (!samples[typ]) samples[typ] = [];
    if (samples[typ].length < MAX_SAMPLES) {
      samples[typ].push({
        original: e.original || '',
        korrektur: e.korrektur || '',
        erklaerung: e.erklaerung || '',
      });
    }
  }
  return { counts, samples };
}

/** Baut die Heatmap-Antwort aus rohen Zeilen.
 *
 *  @param pages       [{ page_id, page_name, chapter_id, chapter_name, position, words }]
 *  @param checks      juengster Check pro Seite:
 *                     [{ id, page_id, checked_at, errors_json, applied_errors_json }]
 *  @param appliedRows alle Checks mit Annahmen, aelteste zuerst:
 *                     [{ id, page_id, checked_at, saved_at, applied_errors_json }]
 *  @param mode        'open' | 'applied' | 'all'
 *  @returns { mode, chapters, matrix, totals, details }
 */
function buildFehlerHeatmap({ pages = [], checks = [], appliedRows = [], mode } = {}) {
  const effMode = normalizeMode(mode);
  const checkByPage = new Map(checks.map(c => [c.page_id, c]));
  const appliedByPage = _appliedRowsByPage(appliedRows);

  // Gruppierung nach Kapitel. chapter_id kann null sein → UNCAT.
  const chapters = new Map();
  for (const p of pages) {
    const key = p.chapter_id ?? UNCAT;
    if (!chapters.has(key)) {
      chapters.set(key, {
        chapter_id: p.chapter_id ?? null,
        chapter_name: p.chapter_name || null,
        position: p.position ?? null,
        pages_total: 0,
        pages_checked: 0,
        words: 0,
        words_checked: 0,
        typen: {},   // { typ: { count, pages: Set<page_id> } }
        details: {}, // { typ: [{ page_id, page_name, count, samples }] }
      });
    }
    const ch = chapters.get(key);
    ch.pages_total++;
    ch.words += Number(p.words) || 0;

    const check = checkByPage.get(p.page_id);
    if (!check) continue;
    ch.pages_checked++;
    ch.words_checked += Number(p.words) || 0;

    const effective = pageFindings(check, appliedByPage.get(p.page_id) || [])[effMode];
    const { counts, samples } = _perPage(effective);

    for (const typ of Object.keys(counts)) {
      if (!ch.typen[typ]) ch.typen[typ] = { count: 0, pages: new Set() };
      ch.typen[typ].count += counts[typ];
      ch.typen[typ].pages.add(p.page_id);
      if (!ch.details[typ]) ch.details[typ] = [];
      ch.details[typ].push({
        page_id: p.page_id,
        page_name: p.page_name || String(p.page_id),
        count: counts[typ],
        samples: samples[typ] || [],
      });
    }
  }

  // Lesereihenfolge des Buchs = `chapters.position` (0-basiert, lueckenlos,
  // Depth-First — materialisiert von db/book-order.js). NICHT `chapter_id`: das
  // ist Anlage-Reihenfolge und weicht ab, sobald im Buchorganizer umsortiert
  // oder ein Kapitel nachtraeglich eingeschoben wurde. Kapitel ohne position
  // (nie durch book-order gelaufen) haengen hinten und fallen auf die ID
  // zurueck; unkategorisiert ganz am Ende.
  const chaptersArr = [...chapters.values()].sort((a, b) => {
    if (a.chapter_id == null || b.chapter_id == null) {
      return (a.chapter_id == null ? 1 : 0) - (b.chapter_id == null ? 1 : 0);
    }
    const ap = a.position ?? Infinity;
    const bp = b.position ?? Infinity;
    if (ap !== bp) return ap - bp;
    return a.chapter_id - b.chapter_id;
  });

  const matrix = {};
  const totals = {};
  const details = {};
  for (const ch of chaptersArr) {
    const key = ch.chapter_id ?? UNCAT;
    matrix[key] = {};
    for (const [typ, v] of Object.entries(ch.typen)) {
      const per1k = ch.words_checked > 0 ? Math.round((v.count / ch.words_checked) * 1000 * 10) / 10 : 0;
      matrix[key][typ] = { count: v.count, per1k, pages: v.pages.size };
      totals[typ] = (totals[typ] || 0) + v.count;
    }
    for (const [typ, arr] of Object.entries(ch.details)) {
      details[`${key}:${typ}`] = arr.sort((a, b) => b.count - a.count);
    }
  }

  return {
    mode: effMode,
    chapters: chaptersArr.map(c => ({
      chapter_id: c.chapter_id,
      chapter_name: c.chapter_name,
      pages_total: c.pages_total,
      pages_checked: c.pages_checked,
      words: c.words,
      words_checked: c.words_checked,
    })),
    matrix,
    totals,
    details,
  };
}

module.exports = { buildFehlerHeatmap, normalizeMode, MODES };
