'use strict';
// Strukturerhaltendes Kürzen von Werkzeug-Ergebnissen (Buch-Chat + Recherche-Chat).
// Rein funktional, keine Abhängigkeiten — der Deckel kommt als Argument
// (shared.js#_truncateResult setzt den Default MAX_RESULT_CHARS).
//
// Reihenfolge, damit das Modell möglichst viel BRAUCHBARES behält:
//   1. Array-Felder auf oberster Ebene halbieren — immer das gerade grösste —,
//      bis das Ergebnis passt oder jedes Array nur noch ein Element hat. Die
//      Skalarfelder daneben (Summen, hint, total_*) bleiben unangetastet: genau die
//      gingen beim harten String-Schnitt am Ende verloren.
//   2. Lange Strings (Snippets, Seitentexte) stufenweise kürzen.
//   3. Letzter Ausweg: harter String-Schnitt.
// Jede Stufe ist endlich (Halbieren bis 1, feste Stufenliste) — keine Rekursion.
//
// Kennzeichnung: `truncated: true`; für `results` zusätzlich `total_results`
// (bestehender Vertrag, wird nur gesetzt, wenn das Tool es nicht selbst tut), für
// jedes andere gekürzte Feld `truncated_fields[key] = { shown, total }`.

const STRING_STEPS = [4000, 1500, 600, 200, 80];

function _size(v) {
  return JSON.stringify(v).length;
}

function _largestArrayKey(obj) {
  let best = null;
  let bestSize = -1;
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v) || v.length <= 1) continue;
    const sz = _size(v);
    if (sz > bestSize) { best = k; bestSize = sz; }
  }
  return best;
}

function _shrinkStrings(v, limit) {
  if (typeof v === 'string') return v.length > limit ? v.slice(0, limit) + '…' : v;
  if (Array.isArray(v)) return v.map(x => _shrinkStrings(x, limit));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = _shrinkStrings(x, limit);
    return out;
  }
  return v;
}

function truncateToolResult(obj, maxChars) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const s = JSON.stringify(obj);
  if (s.length <= maxChars) return obj;

  const totals = {};               // key → ursprüngliche Länge
  let cur = { ...obj };
  const withMeta = (o) => {
    const keys = Object.keys(totals);
    if (!keys.length) return o;
    const out = { ...o, truncated: true };
    const fields = {};
    for (const k of keys) {
      if (k === 'results') {
        if (out.total_results == null) out.total_results = totals[k];
      } else {
        fields[k] = { shown: Array.isArray(o[k]) ? o[k].length : 0, total: totals[k] };
      }
    }
    if (Object.keys(fields).length) out.truncated_fields = { ...(obj.truncated_fields || {}), ...fields };
    return out;
  };

  // Stufe 1: grösstes Array halbieren, bis es passt.
  let candidate = withMeta(cur);
  while (_size(candidate) > maxChars) {
    const key = _largestArrayKey(cur);
    if (!key) break;
    if (!(key in totals)) totals[key] = obj[key].length;
    cur = { ...cur, [key]: cur[key].slice(0, Math.max(1, Math.floor(cur[key].length / 2))) };
    candidate = withMeta(cur);
  }
  if (_size(candidate) <= maxChars) return candidate;

  // Stufe 2: lange Strings kürzen (Snippets/Seitentexte), Skalare bleiben.
  for (const limit of STRING_STEPS) {
    const shrunk = { ..._shrinkStrings(candidate, limit), truncated: true };
    if (_size(shrunk) <= maxChars) return shrunk;
  }

  // Stufe 3: harter Schnitt. Felder stehen in Einfüge-Reihenfolge — wer
  // Zusammenfassungen vorne ablegt, behält sie auch hier.
  return { _truncated: JSON.stringify(candidate).slice(0, Math.max(0, maxChars - 100)) + '… [result truncated]', truncated: true };
}

module.exports = { truncateToolResult };
