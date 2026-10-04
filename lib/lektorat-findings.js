'use strict';
// Was als offener, angenommener oder gemeldeter Lektorat-Befund einer Seite
// zaehlt. Gemeinsamer Kern der Live-Fehler-Heatmap
// ([lib/fehler-heatmap.js](./fehler-heatmap.js)) und der Fassungs-Kennzahl
// ([lib/lektorat-metrics.js](./lektorat-metrics.js), Basis des
// Fehlerdichte-Trends). Beide MUESSEN dieselbe Antwort geben, sonst passt der
// Trend nicht zur Heatmap daneben — darum steht die Regel genau hier.
//
//   all     → alle Befunde des juengsten Checks der Seite
//   applied → angenommene Korrekturen, vereinigt ueber ALLE Checks der Seite
//             (dedupliziert per `original`): angenommen bleibt angenommen, auch
//             wenn die Seite danach neu lektoriert wird
//   open    → Befunde des juengsten Checks minus die Annahmen, die diesen Stand
//             tatsaechlich betreffen
//
// Welche Annahmen den juengsten Stand betreffen: die aus dem juengsten Check
// selbst, und die aus einem aelteren Check, die NACH dem juengsten Lauf
// gespeichert wurden (`saved_at >= latest.checked_at`). Eine Annahme, die schon
// vor dem juengsten Lauf gespeichert war, steckt bereits im Text, den dieser Lauf
// gesehen hat — meldet er dasselbe `original` erneut, ist das ein weiteres,
// echtes Vorkommen und bleibt offen.
//
// Abgleich als Multimenge per `original`: eine Annahme deckt genau einen Befund.
// Zwei gemeldete „ploetzlich", eines angenommen → eines bleibt offen.
// Befunde ohne `original` lassen sich nicht abgleichen und zaehlen als offen.

// JSON-Spalte defensiv zu einem Array parsen: eine korrupte Zeile darf keine
// Aggregation kippen.
function parseFindings(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function _sameCheck(a, b) {
  if (a.id != null && b.id != null) return a.id === b.id;
  return a.checked_at != null && a.checked_at === b.checked_at;
}

/** Befunde EINER Seite nach Modus.
 *
 *  @param latest      juengster Check: { id?, checked_at, errors_json, applied_errors_json? }
 *  @param appliedRows alle Checks der Seite mit Annahmen, aelteste zuerst:
 *                     [{ id?, checked_at, saved_at, applied_errors_json }]
 *                     (der juengste darf darin vorkommen oder fehlen)
 *  @returns { open, applied, all } — je ein Array von Findings
 */
function pageFindings(latest, appliedRows = []) {
  const all = latest ? parseFindings(latest.errors_json) : [];

  // Kumulative Union: der erste (aelteste) Treffer je `original` gewinnt.
  const appliedByOriginal = new Map();
  const consume = new Map(); // original -> Anzahl Befunde, die die Annahmen decken
  const rows = [...appliedRows];
  if (latest?.applied_errors_json && !rows.some(r => _sameCheck(r, latest))) rows.push(latest);
  for (const row of rows) {
    const entries = parseFindings(row.applied_errors_json);
    const hitsLatest = latest && (_sameCheck(row, latest)
      || (row.saved_at && latest.checked_at && row.saved_at >= latest.checked_at));
    for (const e of entries) {
      if (!e?.original) continue;
      if (!appliedByOriginal.has(e.original)) appliedByOriginal.set(e.original, e);
      if (hitsLatest) consume.set(e.original, (consume.get(e.original) || 0) + 1);
    }
  }

  const open = [];
  for (const e of all) {
    const left = e?.original ? consume.get(e.original) || 0 : 0;
    if (left > 0) { consume.set(e.original, left - 1); continue; }
    open.push(e);
  }

  return { open, applied: [...appliedByOriginal.values()], all };
}

module.exports = { pageFindings, parseFindings };
