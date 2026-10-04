// Caret über einen kompletten Inhalts-Austausch retten, verankert am Block statt
// am Text-Offset ab Editor-Anfang. Konsument: notebook/edit/conflict.js#
// `_applyMergedToEditor` (Notebook + Focus, gemergter Remote-Stand).
//
// Warum nicht `captureCaretOffset(root)` aus edit-history.js: ein Merge fügt
// Remote-Text OBERHALB des Carets ein, und ein globaler Offset landet danach im
// falschen Absatz. Der Block mit seiner `data-bid` überlebt den Merge (bzw. der
// lokal frisch getippte Block ohne bid steht weiter hinter seinem letzten
// bid-Vorgänger), der Offset innerhalb des Blocks bleibt gültig.

import { captureCaretOffset, restoreCaretAtOffset } from './edit-history.js';

function topBlockOf(root, node) {
  let n = node;
  while (n && n.parentNode !== root) n = n.parentNode;
  return n && n.nodeType === 1 ? n : null;
}

// { bid, steps, offset } — `bid` des Caret-Blocks oder seines nächsten
// Vorgängers mit bid (`steps` Geschwister dahinter; bid null = ab Editor-Anfang),
// `offset` als Text-Offset im Caret-Block. null, wenn der Caret nicht im Editor steht.
export function captureBlockCaret(root) {
  if (!root) return null;
  const sel = root.ownerDocument?.defaultView?.getSelection?.()
    ?? (typeof document !== 'undefined' ? document.getSelection?.() : null);
  if (!sel || sel.rangeCount === 0) return null;
  const node = sel.getRangeAt(0).startContainer;
  if (!root.contains(node)) return null;
  const block = topBlockOf(root, node);
  if (!block) return null;
  const offset = captureCaretOffset(block);
  if (offset == null) return null;
  let anchor = block;
  let steps = 0;
  while (anchor && !anchor.getAttribute?.('data-bid')) {
    anchor = anchor.previousElementSibling;
    steps++;
  }
  return { bid: anchor ? anchor.getAttribute('data-bid') : null, steps: anchor ? steps : steps - 1, offset };
}

export function restoreBlockCaret(root, caret) {
  if (!root || !caret) return;
  let block;
  if (caret.bid) {
    block = [...root.children].find(c => c.getAttribute('data-bid') === caret.bid) || null;
    // Anker-Block remote gelöscht: kein sinnvoller Ort — Caret bleibt, wo der Mount ihn liess.
    if (!block) return;
  } else {
    block = root.firstElementChild;
  }
  for (let i = 0; i < caret.steps && block?.nextElementSibling; i++) block = block.nextElementSibling;
  if (!block) return;
  const len = (block.textContent || '').length;
  restoreCaretAtOffset(block, Math.min(caret.offset, len));
}
