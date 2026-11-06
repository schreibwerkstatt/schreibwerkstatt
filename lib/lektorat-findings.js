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
//
// `applied` ist ebenfalls eine Multimenge — innerhalb EINES Laufs zaehlt jedes
// angenommene Vorkommen (zwei „ploetzlich" uebernommen = zwei). Ueber Laeufe
// hinweg gilt je `original` die groesste Anzahl eines einzelnen Laufs: dieselbe
// Annahme, die in einem spaeteren Lauf erneut gebucht steht, zaehlt nicht doppelt.
// Sonst ergaebe offen + angenommen mehr oder weniger als gemeldet.
//
// „Juengster Check" heisst ueberall: groesstes `checked_at`, bei Gleichstand
// groesste `id` (compareChecks). Heatmap-SQL, Fassungs-Kennzahl und Verlauf
// muessen bei gleicher Zeit denselben Lauf waehlen.

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

/** Chronologische Ordnung zweier Checks: `checked_at` (ISO+Z, String-Vergleich
 *  ist chronologisch), bei Gleichstand `id`. Aufsteigend — aeltester zuerst. */
function compareChecks(a, b) {
  const ta = String(a?.checked_at || '');
  const tb = String(b?.checked_at || '');
  if (ta !== tb) return ta < tb ? -1 : 1;
  return (Number(a?.id) || 0) - (Number(b?.id) || 0);
}

/** Juengster Check aus einer Liste (null bei leerer Liste). */
function latestCheck(rows) {
  let best = null;
  for (const r of rows || []) if (r && (!best || compareChecks(r, best) > 0)) best = r;
  return best;
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

  // applied: je `original` die Eintraege des Laufs mit den meisten Vorkommen;
  // bei Gleichstand bleibt der aelteste (stabiler `typ`, wenn ein Re-Lektorat
  // umklassifiziert). Reihenfolge = erstes Auftreten.
  const appliedByOriginal = new Map(); // original -> Array der Eintraege
  const consume = new Map(); // original -> Anzahl Befunde, die die Annahmen decken
  const rows = [...appliedRows];
  if (latest?.applied_errors_json && !rows.some(r => _sameCheck(r, latest))) rows.push(latest);
  for (const row of rows) {
    const entries = parseFindings(row.applied_errors_json);
    const hitsLatest = latest && (_sameCheck(row, latest)
      || (row.saved_at && latest.checked_at && row.saved_at >= latest.checked_at));
    const inRow = new Map();
    for (const e of entries) {
      if (!e?.original) continue;
      let arr = inRow.get(e.original);
      if (!arr) { arr = []; inRow.set(e.original, arr); }
      arr.push(e);
      if (hitsLatest) consume.set(e.original, (consume.get(e.original) || 0) + 1);
    }
    for (const [orig, arr] of inRow) {
      const prev = appliedByOriginal.get(orig);
      if (!prev || arr.length > prev.length) appliedByOriginal.set(orig, prev ? [...prev, ...arr.slice(prev.length)] : arr);
    }
  }

  const open = [];
  for (const e of all) {
    const left = e?.original ? consume.get(e.original) || 0 : 0;
    if (left > 0) { consume.set(e.original, left - 1); continue; }
    open.push(e);
  }

  return { open, applied: [...appliedByOriginal.values()].flat(), all };
}

module.exports = { pageFindings, parseFindings, compareChecks, latestCheck };
