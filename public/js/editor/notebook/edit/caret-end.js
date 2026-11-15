// Notebook-Editor: Caret beim Eintritt in den Edit-Modus (startEdit) ans Ende.

// Letzter Textknoten des Editors (nicht in atomaren Chips) — so landet der
// Caret auch in Liste, Zitat oder Tabelle in der letzten Zeile statt hinter
// dem Wrapper. Leere Seite (`<p><br></p>`) → Anfang des letzten Blocks.
export function placeCaretAtEditorEnd(ed) {
  try { ed.focus({ preventScroll: true }); } catch { ed.focus?.(); }
  const lastBlock = ed.lastElementChild;
  if (!lastBlock) return;
  const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue.trim() && !n.parentElement?.closest('[contenteditable="false"]'))
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  let lastText = null, n;
  while ((n = walker.nextNode())) lastText = n;
  const range = document.createRange();
  if (lastText && lastBlock.contains(lastText)) range.setStart(lastText, lastText.nodeValue.length);
  else range.setStart(lastBlock, 0);
  range.collapse(true);
  const sel = document.getSelection();
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  try { lastBlock.scrollIntoView({ block: 'center', behavior: 'instant' }); }
  catch { lastBlock.scrollIntoView?.(); }
}

// Der Edit-Container steht direkt nach startEdit noch unter `display:none`
// (Alpine-x-show noch nicht geflusht) — `focus()` und `scrollIntoView` greifen
// dort nicht. Darum Frame für Frame warten, bis er Layout hat (höchstens ~1 s).
export function whenEditorVisible(getEl, stillWanted, fn, frames = 60) {
  const tick = () => {
    if (!stillWanted()) return;
    const el = getEl();
    if (el && el.getClientRects().length) {
      // Hat inzwischen ein Klick (oder anderer Code) den Editor fokussiert,
      // gehört der Caret dorthin — nicht ans Ende überschreiben.
      if (!el.contains(document.activeElement)) fn(el);
      return;
    }
    if (--frames > 0) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
