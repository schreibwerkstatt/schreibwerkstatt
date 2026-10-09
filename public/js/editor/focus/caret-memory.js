// Schreibstelle pro Abschnitt: wo der Caret beim Verlassen des Fokusmodus
// stand, setzt ihn der naechste Eintritt wieder hin — statt immer ans Ende.
// Ein Kapitel aus einem einzigen 50k-Abschnitt wird sonst bei jeder Ueberarbeitung
// in der Mitte erst wieder von Hand angescrollt.
//
// Bewusst schmal: gemerkt wird NUR eine Stelle VOR dem letzten Block. Steht der
// Caret am Ende (letzter Block oder der Auto-`<p>`-Slot), wird nichts gemerkt
// und der Eintritt bleibt der gewohnte Sprung ans Ende samt Slot (docs/
// focus-editor.md „Auto-`<p>`-Slot") — wer am Ende weiterschreibt, merkt von
// diesem Modul nichts.
//
// Adresse: `data-bid` des Top-Level-Blocks (stabil ueber Saves, html-clean.js
// #ensureBlockIds) + Zeichen-Offset im Block. Ohne bid (frischer, noch nicht
// gespeicherter Block) gibt es keine stabile Adresse → nichts merken.
// localStorage pro Geraet/Abschnitt; jeder Zugriff in try/catch.

const KEY = 'focus.caret.';

function topBlockOf(container, node) {
  let cur = node?.nodeType === 1 ? node : node?.parentElement;
  while (cur && cur.parentElement !== container) cur = cur.parentElement;
  return cur && cur.parentElement === container ? cur : null;
}

function textOffsetIn(block, node, offset) {
  try {
    const r = document.createRange();
    r.selectNodeContents(block);
    r.setEnd(node, offset);
    return r.toString().length;
  } catch { return 0; }
}

// Beim Exit, solange der Fokus-Container noch im DOM steht.
export function rememberFocusCaret(container, pageId) {
  if (!container || pageId == null) return;
  let pos = null;
  const sel = document.getSelection();
  if (sel && sel.rangeCount && container.contains(sel.anchorNode)) {
    const block = topBlockOf(container, sel.anchorNode);
    const last = container.lastElementChild;
    // Vorletzter Block mit leerem Auto-Slot dahinter zaehlt ebenfalls als Ende:
    // der Slot faellt beim Exit weg, und der Block ist dann der letzte.
    const atEnd = !block || block === last
      || (block.nextElementSibling === last && !last.textContent.trim());
    if (!atEnd && block.dataset.bid) {
      pos = { bid: block.dataset.bid, offset: textOffsetIn(block, sel.anchorNode, sel.anchorOffset) };
    }
  }
  try {
    if (pos) localStorage.setItem(KEY + pageId, JSON.stringify(pos));
    else localStorage.removeItem(KEY + pageId);
  } catch { /* Storage aus/voll — dann eben ans Ende */ }
}

// Beim Eintritt. Liefert den Block, in den der Caret gesetzt wurde, oder null
// (nichts gemerkt, Block weg oder inzwischen der letzte) — dann gilt der
// gewohnte Sprung ans Ende.
export function restoreFocusCaret(container, pageId) {
  if (!container || pageId == null) return null;
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(KEY + pageId) || 'null'); } catch { pos = null; }
  if (!pos?.bid) return null;
  const block = [...container.children].find(el => el.dataset?.bid === pos.bid);
  if (!block || block === container.lastElementChild) return null;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  let rest = Math.max(0, Number(pos.offset) || 0);
  let node = null, at = 0, n;
  while ((n = walker.nextNode())) {
    node = n;
    if (rest <= n.nodeValue.length) { at = rest; break; }
    rest -= n.nodeValue.length;
    at = n.nodeValue.length;
  }
  const range = document.createRange();
  if (node) range.setStart(node, at); else range.setStart(block, 0);
  range.collapse(true);
  const sel = document.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  try { container.focus({ preventScroll: true }); } catch { container.focus?.(); }
  return block;
}
