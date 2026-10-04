'use strict';

// Verdichtet einen Satz page_checks-Zeilen zu Fehler-Kennzahlen pro Modus
// (open/applied/all), aufgeschlüsselt nach Fehlertyp. Gemeinsame SSoT für den
// Snapshot-Capture (routes/snapshots/payload.js), den Migrations-Backfill
// (db/migrations.js) und — über den Fehlerdichte-Trend — die Fehler-Heatmap-Karte.
//
// Was pro Seite als offen/angenommen/gemeldet zählt, entscheidet
// [lib/lektorat-findings.js](./lektorat-findings.js) — derselbe Kern wie bei der
// Live-Heatmap (lib/fehler-heatmap.js). Anders als die Heatmap aggregiert dieser
// Helper buchweit (kein user_email-Filter) — eine Fassung ist ein
// Buch-Meilenstein, nicht die Sicht eines einzelnen Users; in der Praxis
// (Einzelautor) deckt sich beides.
//
//   computeLektoratMetrics(pageCheckRows, { wordsByPage }) → {
//     open:    { total, byTyp: { typ: count } },
//     applied: { total, byTyp },
//     all:     { total, byTyp },
//     words_checked,   // nur mit wordsByPage: Wörter der geprüften Seiten
//   }
//
// `words_checked` ist der Nenner der Fehlerdichte im Trend — wie bei der Heatmap
// die Wörter der GEPRÜFTEN Seiten, nicht des ganzen Buchs. Gegen den Buchumfang
// sänke die Dichte mit jeder ungeprüft dazugeschriebenen Seite, ohne dass sich
// am Text etwas verbessert hätte. Gezählt werden nur Seiten, die in
// `wordsByPage` stehen (= in der Fassung existieren).
//
// Erwartete Zeilen-Form: { id?, page_id, checked_at, saved_at?, errors_json,
// applied_errors_json }. JSON-Felder als Strings; Defektes gilt als leer.

const { pageFindings } = require('./lektorat-findings');

// Findings → { total, byTyp }. Nur Findings mit gesetztem `typ` zählen (wie die
// Heatmap); der Lektorat-Job filtert ohnehin auf VALID_TYPEN vor dem Write.
function _tally(findings) {
  const byTyp = {};
  let total = 0;
  for (const e of findings) {
    const typ = e?.typ;
    if (!typ) continue;
    byTyp[typ] = (byTyp[typ] || 0) + 1;
    total += 1;
  }
  return { total, byTyp };
}

function computeLektoratMetrics(pageCheckRows, { wordsByPage = null } = {}) {
  const rows = Array.isArray(pageCheckRows) ? pageCheckRows : [];

  // Pro Seite: jüngster Check (checked_at ist ISO+Z → String-Vergleich ist
  // chronologisch) + alle Checks mit Annahmen, älteste zuerst.
  const byPage = new Map();
  for (const r of rows) {
    const pid = r?.page_id;
    if (pid == null) continue;
    let g = byPage.get(pid);
    if (!g) { g = { latest: null, applied: [] }; byPage.set(pid, g); }
    if (!g.latest || String(r.checked_at || '') > String(g.latest.checked_at || '')) g.latest = r;
    if (r.applied_errors_json) g.applied.push(r);
  }

  const open = [];
  const applied = [];
  const all = [];
  let wordsChecked = 0;
  for (const [pid, g] of byPage) {
    g.applied.sort((a, b) => String(a.checked_at || '').localeCompare(String(b.checked_at || '')));
    const f = pageFindings(g.latest, g.applied);
    open.push(...f.open);
    applied.push(...f.applied);
    all.push(...f.all);
    if (wordsByPage) wordsChecked += Number(wordsByPage.get(Number(pid))) || 0;
  }

  const out = { open: _tally(open), applied: _tally(applied), all: _tally(all) };
  if (wordsByPage) out.words_checked = wordsChecked;
  return out;
}

module.exports = { computeLektoratMetrics };
