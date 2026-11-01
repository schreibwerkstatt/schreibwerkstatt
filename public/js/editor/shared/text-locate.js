// Tolerante Fundstellen-Suche im DOM (Live-Editor oder Leseansicht): findet
// eine Phrase mit derselben Toleranz wie `countInHtml` (Whitespace kollabiert,
// Anführungszeichen gefaltet), damit Hervorhebung und Apply-Guard dieselbe
// Stelle meinen — nach dem Übernehmen stehen die Anführungszeichen im
// Buch-Stil, die KI schreibt sie gerade.
//
// Konsumenten: Abschnitts-Chat (chat/page-chat-marks.js, Hinzeigen auf einen
// Vorschlag) und Lektorat im Notebook-Edit-Modus (editor/lektorat-live.js,
// alle Befunde je Tipp-Pause). Der Index wird einmal je Container-Stand gebaut
// und für beliebig viele Phrasen befragt — das Lektorat sucht bis zu einigen
// hundert Befunde in einem Abschnitt von 40'000 Zeichen.
//
// Text-Nodes werden ohne Trenner verkettet (Inline-Tags tragen ihren Leerraum
// selbst); eine Block-Grenze überspannt eine gesuchte Phrase nie.

import { foldQuotes, normalizeMatchText } from '../../utils/text-match.js';
import { collectTextNodes } from './text-find.js';

/** Index über alle Text-Nodes unter `container`: gefalteter Klartext mit
 *  kollabiertem Whitespace und je Zeichen die Herkunft (Node + Offset). */
export function buildLocateIndex(container) {
  const chars = [];
  const pos = [];
  if (container) {
    let pendingSpace = false;
    for (const node of collectTextNodes(container)) {
      const v = node.nodeValue || '';
      for (let i = 0; i < v.length; i++) {
        if (/\s/.test(v[i])) { if (chars.length) pendingSpace = true; continue; }
        if (pendingSpace) { chars.push(' '); pos.push({ node, i }); pendingSpace = false; }
        chars.push(v[i]);
        pos.push({ node, i });
      }
    }
  }
  return { text: foldQuotes(chars.join('')), pos };
}

function _match(index, idx, len) {
  const a = index.pos[idx];
  const b = index.pos[idx + len - 1];
  return { startNode: a.node, startOffset: a.i, endNode: b.node, endOffset: b.i + 1 };
}

// Nicht-überlappende Vorkommen (gleiche Zählweise wie `countInText`).
function _offsets(index, n) {
  const out = [];
  if (!index || !n) return out;
  let from = 0;
  let idx;
  while ((idx = index.text.indexOf(n, from)) !== -1) {
    out.push(idx);
    from = idx + n.length;
  }
  return out;
}

/** Erste Fundstelle von `needle` im Index als Match-Tupel
 *  ({ startNode, startOffset, endNode, endOffset }) oder null. */
export function locateInIndex(index, needle) {
  const n = normalizeMatchText(needle);
  if (!index || !n) return null;
  const idx = index.text.indexOf(n);
  return idx === -1 ? null : _match(index, idx, n.length);
}

/** Alle Fundstellen von `needle` im Index, in Textreihenfolge. */
export function locateAllInIndex(index, needle) {
  const n = normalizeMatchText(needle);
  return _offsets(index, n).map(idx => _match(index, idx, n.length));
}

/** Zeichen-Offset der ersten Fundstelle im Index-Text, -1 wenn keine. */
export function offsetInIndex(index, needle) {
  const n = normalizeMatchText(needle);
  return index && n ? index.text.indexOf(n) : -1;
}

/** DOM-Punkt hinter dem Index-Zeichen `offset - 1` (Caret-Position), oder null. */
export function pointAfterOffset(index, offset) {
  const p = index?.pos[offset - 1];
  return p ? { node: p.node, offset: p.i + 1 } : null;
}

/** Einzelsuche: Index bauen und einmal fragen. */
export function locateInContainer(container, needle) {
  if (!container || !normalizeMatchText(needle)) return null;
  return locateInIndex(buildLocateIndex(container), needle);
}
