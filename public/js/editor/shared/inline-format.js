// Inline-Formate (Fett/Kursiv/Unterstrichen) per `execCommand`, ohne dass ein
// Inline-`style` im Manuskript zurückbleibt. Framework-frei.

import { findBlock } from './dom-block.js';

// Fett/Kursiv per `execCommand`, ohne Inline-`style` zu hinterlassen. In einem
// Block, den CSS schon kursiv (Zitat) bzw. fett (Überschrift) setzt, „schaltet"
// Chromium das Format über `<span style="font-style: normal">` bzw.
// `font-weight: normal` um — Inline-`style` verstösst gegen „Styles nur in
// public/css" und wird mitgespeichert. Darum:
//   • mit Auswahl: Befehl ausführen, danach jedes dabei NEU entstandene
//     `style` entfernen (Span auspacken, sonst Attribut weg). Im CSS-Kontext
//     bleibt der Griff damit wirkungslos, ein vorhandenes `<em>`/`<strong>`
//     wird trotzdem entfernt.
//   • ohne Auswahl im CSS-Kontext: nichts tun — der Browser merkte sich sonst
//     ein Schreibformat, das beim nächsten Zeichen als `style`-Span landet.
// Konsumenten: Notebook-Toolbar (`_applyInline`: Bubble-Knöpfe, Cmd/Ctrl+B/I)
// und `bindInlineFormattingShortcuts` (shared/shortcuts.js) für den Fokusmodus
// — SPA und Standalone-Mount der nativen Clients (OTA-Bundle).
const INLINE_CSS_CHECK = {
  bold: (cs) => (parseInt(cs.fontWeight, 10) || 400) >= 600,
  italic: (cs) => cs.fontStyle === 'italic' || cs.fontStyle === 'oblique',
};

export function applyInlineCommand(editEl, command) {
  const sel = document.getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const check = INLINE_CSS_CHECK[command];
  if (range?.collapsed && check) {
    const block = findBlock(range.startContainer, editEl);
    if (block && check(getComputedStyle(block))) return false;
  }
  const before = new Set(editEl.querySelectorAll('[style]'));
  document.execCommand(command, false);
  const fresh = Array.from(editEl.querySelectorAll('[style]')).filter((el) => !before.has(el));
  if (!fresh.length) return true;
  const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  const pts = r ? [r.startContainer, r.startOffset, r.endContainer, r.endOffset] : null;
  for (const el of fresh) {
    if (el.tagName !== 'SPAN') { el.removeAttribute('style'); continue; }
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    el.remove();
  }
  if (pts && pts[0].isConnected && pts[2].isConnected) {
    try {
      const nr = document.createRange();
      nr.setStart(pts[0], pts[1]);
      nr.setEnd(pts[2], pts[3]);
      sel.removeAllRanges();
      sel.addRange(nr);
    } catch { /* Offsets passen nicht mehr — Auswahl bleibt, wie sie ist */ }
  }
  return true;
}
