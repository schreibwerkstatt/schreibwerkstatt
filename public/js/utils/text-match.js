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
//
// `tagGapIsSpace` (unten) gehört dazu: es entscheidet, WO eine Klartext-Sicht
// aus HTML überhaupt ein Wort trennt.

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

// Zeichen, die sich nach LINKS binden (Punkt, Komma, …, schliessende Klammer,
// schliessendes Anfuehrungszeichen) bzw. nach RECHTS (oeffnende Klammer, «, „).
// Zeichen-Klassen-SSoT ist die Server-Zwilling-Kopie in
// lib/html-text.js#stripTagsKeepPunctuation.
const _BINDS_LEFT = /[.,;:!?%…»›“”‘’)\]}]/;
const _BINDS_RIGHT = /[([{«‹„‚]/;

// Erstes Zeichen neben einem (vielleicht mehreren) Tag-Lauf. Der Lauf wird
// übersprungen, weil `stripTagsKeepPunctuation` die Marken eines Laufs
// einstimmig auflöst — sonst entstünde zwischen zwei Tags ein Space, den die
// Nachbarn nicht wollen. Whitespace wird NICHT übersprungen: ein vorhandenes
// Leerzeichen trennt ohnehin, und genau dann bleibt es beim Space.
function _charBesideTags(html, from, dir) {
  let i = from;
  while (i >= 0 && i < html.length) {
    if (dir < 0 && html[i] === '>') {
      const lt = html.lastIndexOf('<', i);
      if (lt === -1) return '';
      i = lt - 1;
      continue;
    }
    if (dir > 0 && html[i] === '<') {
      const gt = html.indexOf('>', i);
      if (gt === -1) return '';
      i = gt + 1;
      continue;
    }
    return html[i];
  }
  return '';
}

/** Wirkt die Tag-Grenze `html.slice(tagStart, tagEnd)` (ein Tag) als Wortgrenze,
 *  also als Space in der Klartext-Sicht? `tagEnd` ist der Index hinter dem `>`.
 *
 *  Die Fundstellen-View (public/js/utils/html-find.js) und der Prompt-Text, aus
 *  dem die KI ihr `original` zitiert (lib/html-text.js), müssen DIESELBE Sicht
 *  zeigen — sonst findet ein Befund wie «Asianometry.» (so steht es im Prompt)
 *  seine Stelle nicht und fällt als „nicht gefunden“ ersatzlos heraus. */
export function tagGapIsSpace(html, tagStart, tagEnd) {
  const prev = _charBesideTags(html, tagStart - 1, -1);
  const next = _charBesideTags(html, tagEnd, +1);
  if (!prev || !next) return true;
  if (/\s/.test(prev) || /\s/.test(next)) return true;
  return !(_BINDS_RIGHT.test(prev) || _BINDS_LEFT.test(next));
}
