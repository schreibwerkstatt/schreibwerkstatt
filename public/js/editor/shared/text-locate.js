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
// Wo zwischen zwei Text-Nodes ein Leerzeichen steht, entscheidet dieselbe Regel
// wie in der HTML-Sicht (`findInHtml`, utils/text-match.js#tagGapIsSpace) und im
// Prompt-Text der KI: eine Block-Grenze trennt immer, eine Inline-Tag-Grenze
// zwischen zwei Wortzeichen auch (`<b>Un</b>glück` → „Un glück"), vor einem
// Satzzeichen bzw. nach einer öffnenden Klammer nicht. Sonst fände ein Befund
// in der Leseansicht seine Stelle und gälte im Edit-Modus als umgeschrieben.

import { foldQuotes, normalizeMatchText, BINDS_LEFT, BINDS_RIGHT, BLOCK_TAG } from '../../utils/text-match.js';
import { collectTextNodes } from './text-find.js';

/** Index über alle Text-Nodes unter `container`: gefalteter Klartext mit
 *  kollabiertem Whitespace und je Zeichen die Herkunft (Node + Offset). */
export function buildLocateIndex(container) {
  const chars = [];
  const pos = [];
  if (container) {
    let pendingSpace = false;
    let prevNode = null;
    for (const node of collectTextNodes(container)) {
      const v = node.nodeValue || '';
      let first = true;
      for (let i = 0; i < v.length; i++) {
        if (/\s/.test(v[i])) { if (chars.length) pendingSpace = true; continue; }
        if (first && !pendingSpace && prevNode && chars.length && _gapIsSpace(prevNode, node, chars[chars.length - 1], v[i])) pendingSpace = true;
        first = false;
        if (pendingSpace) { chars.push(' '); pos.push({ node, i }); pendingSpace = false; }
        chars.push(v[i]);
        pos.push({ node, i });
      }
      if (!first) prevNode = node;
    }
  }
  return { text: foldQuotes(chars.join('')), pos };
}

const _isBlockEl = (el) => BLOCK_TAG.test('<' + el.localName + '>');

// Liegt zwischen den Text-Nodes `a` und `b` (Dokumentreihenfolge) eine
// Tag-Grenze, und wirkt sie als Wortgrenze? Spiegel von `tagGapIsSpace` für
// den DOM: Block-Element auf dem Weg (geschlossen, geöffnet oder dazwischen,
// auch `<br>`) → ja; nur Inline-Tags → je nach den Zeichen daneben; gar kein
// Tag (zwei Geschwister-Text-Nodes) → nein.
function _gapIsSpace(a, b, prevCh, nextCh) {
  const up = new Set();
  for (let n = a.parentNode; n; n = n.parentNode) up.add(n);
  let common = b.parentNode;
  while (common && !up.has(common)) common = common.parentNode;
  let tag = false;
  let block = false;
  const note = (el) => { tag = true; if (_isBlockEl(el)) block = true; };
  let topA = a;
  for (let n = a.parentNode; n && n !== common; n = n.parentNode) { note(n); topA = n; }
  let topB = b;
  for (let n = b.parentNode; n && n !== common; n = n.parentNode) { note(n); topB = n; }
  for (let x = topA.nextSibling; x && x !== topB && !block; x = x.nextSibling) {
    if (x.nodeType !== 1) continue;
    note(x);
    for (const d of x.querySelectorAll('*')) if (_isBlockEl(d)) { block = true; break; }
  }
  if (block) return true;
  if (!tag) return false;
  return !(BINDS_RIGHT.test(prevCh) || BINDS_LEFT.test(nextCh));
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

/** Match-Tupel für `len` Zeichen ab Index-Offset `offset`, oder null. */
export function locateAtOffset(index, offset, len) {
  if (!index || offset < 0 || len <= 0 || offset + len > index.pos.length) return null;
  return _match(index, offset, len);
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
