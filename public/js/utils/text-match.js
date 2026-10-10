// Text-Vergleich für Fundstellen-Suche (pure, ohne DOM): Anführungszeichen-
// Faltung + Whitespace-Normalform. Geteilt von html-find.js (Browser: Suchen/
// Ersetzen in HTML) und dem Abschnitts-Chat-Job (Server via lib/esm-bridge.js:
// Prüfung von `vorschlaege.original` gegen den Abschnittstext) — beide Seiten
// müssen dieselbe Stelle für „gleich" halten, sonst meldet der Server
// „nicht gefunden", was der Client übernehmen kann (oder umgekehrt).
//
// Warum Faltung: die KI sieht und schreibt Anführungszeichen selten so, wie sie
// im Buch stehen (gerade `"` statt «» / „“), und das Übernehmen normalisiert sie
// nachträglich auf den Buch-Stil (editor/shared/quote-normalize.js). Ohne
// Faltung fände weder der Apply-Guard das Original noch Rückgängig den
// eingesetzten Ersatz.

const DOUBLE_QUOTES = '"„“”«»‟';
const SINGLE_QUOTES = '\'‚‘’‹›‛';

const _FOLD = new Map();
for (const ch of DOUBLE_QUOTES) _FOLD.set(ch, '"');
for (const ch of SINGLE_QUOTES) _FOLD.set(ch, '\'');
const _FOLD_RE = new RegExp(`[${[...DOUBLE_QUOTES, ...SINGLE_QUOTES].join('').replace(/[\\\]^-]/g, '\\$&')}]`, 'g');

/** Typografische Anführungszeichen/Apostrophe auf `"` bzw. `'` falten.
 *  Längenerhaltend (1 Zeichen → 1 Zeichen) — Positionen bleiben gültig. */
export function foldQuotes(s) {
  return String(s ?? '').replace(_FOLD_RE, ch => _FOLD.get(ch));
}

/** Vergleichs-Normalform einer gesuchten Phrase: Whitespace kollabiert,
 *  Ränder getrimmt, Anführungszeichen gefaltet. */
export function normalizeMatchText(s) {
  return foldQuotes(String(s ?? '').replace(/\s+/g, ' ').trim());
}

/** Nicht-überlappende Vorkommen von `needle` in `text` (beide werden in die
 *  Normalform gebracht). `text` ist eine Klartext-Sicht (Tags → Space). */
export function countInText(text, needle) {
  const n = normalizeMatchText(needle);
  if (!n) return 0;
  const hay = normalizeMatchText(text);
  let count = 0;
  let from = 0;
  let idx;
  while ((idx = hay.indexOf(n, from)) !== -1) {
    count++;
    from = idx + n.length;
  }
  return count;
}
