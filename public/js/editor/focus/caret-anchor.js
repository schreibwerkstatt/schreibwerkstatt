// Caret-Adresse über einen Inhaltstausch hinweg — für `replaceContent` der
// Standalone-Schale (standalone.js): ein gemergter Server-Stand desselben
// Abschnitts ersetzt das DOM, der Caret soll danach im selben Block an derselben
// Textstelle stehen.
//
// Anders als caret-memory.js (Schreibstelle beim Verlassen, bewusst nur VOR dem
// letzten Block) gilt hier jeder Block, auch der letzte: der Tausch passiert
// mitten im Schreiben, meist genau am Ende.
//
// Adresse in drei Stufen, die erste auflösbare gewinnt:
//   1. `data-bid` des eigenen Top-Level-Blocks + Text-Offset darin.
//   2. Nächster Vorgänger MIT `data-bid` + Abstand in Blöcken. Fängt Blöcke
//      ohne (oder mit inzwischen neu vergebener) Id ab — ein frisch per Enter
//      angelegter Absatz trägt seine Id erst ab dem Server-Write.
//   3. Text-Offset ab Container-Anfang (geteilter Kern aus edit-history.js).
// `slot` markiert den leeren Schluss-Absatz: der Server strippt leere `<p>`, der
// Aufrufer legt ihn dann wieder an, statt den Caret ans Ende des Vorgängers
// zu setzen.

import { captureCaretOffset, restoreCaretAtOffset } from '../shared/edit-history.js';
import { isEmptyParagraph } from '../shared/auto-slot.js';

function topBlockOf(container, node) {
  let cur = node?.nodeType === 1 ? node : node?.parentElement;
  while (cur && cur.parentElement !== container) cur = cur.parentElement;
  return cur && cur.parentElement === container ? cur : null;
}

export function captureCaretAnchor(container) {
  const sel = document.getSelection();
  if (!container || !sel || !sel.rangeCount || !container.contains(sel.anchorNode)) return null;
  const block = topBlockOf(container, sel.anchorNode);
  if (!block) return { global: captureCaretOffset(container) };
  const slot = block === container.lastElementChild && isEmptyParagraph(block);
  let anchorBid = null;
  let steps = 0;
  for (let cur = block.previousElementSibling, n = 1; cur; cur = cur.previousElementSibling, n++) {
    if (cur.dataset?.bid) { anchorBid = cur.dataset.bid; steps = n; break; }
  }
  if (!anchorBid) steps = [...container.children].indexOf(block);
  return {
    bid: block.dataset?.bid || null,
    anchorBid,
    steps,
    offset: captureCaretOffset(block) ?? 0,
    global: captureCaretOffset(container),
    slot,
  };
}

// Liefert den Block, in den der Caret gesetzt wurde (null: Stufe 3 oder nichts).
export function restoreCaretAnchor(container, addr) {
  if (!container || !addr) return null;
  const kids = [...container.children];
  let block = addr.bid ? kids.find(el => el.dataset?.bid === addr.bid) : null;
  if (!block) {
    const from = addr.anchorBid ? kids.findIndex(el => el.dataset?.bid === addr.anchorBid) : 0;
    if (from >= 0) block = kids[Math.min(from + addr.steps, kids.length - 1)] || null;
  }
  if (!block) {
    restoreCaretAtOffset(container, addr.global);
    return null;
  }
  restoreCaretAtOffset(block, Math.min(addr.offset, (block.textContent || '').length));
  return block;
}
