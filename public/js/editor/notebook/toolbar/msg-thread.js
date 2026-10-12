// editorToolbarCard: Nachrichtenverlauf (div.msg-thread) im Notebook-Editor —
// Tastatur (Enter/Tab/Backspace/Delete) und die schwebende Zeilenleiste
// (Eingang/Ausgang/Absender/Hinweis). `this` = Sub-Komponente (editorToolbarCard).
//
// Der Focus-Editor nutzt Enter und die Merges mit (Dispatcher-Ausnahme am
// Focus-Hard-Stop in keydown.js); Tab und die Zeilenleiste bleiben Notebook —
// der Focus-Editor zeigt die Zeilenarten nicht, ein Seitenwechsel per Tab
// bliebe dort unsichtbar. Die Leiste ist im Template auf `!$app.focusActive`
// gegated. Der Bucheditor stellt den Verlauf dar, bedient ihn aber nicht.
//
// Warum Merges hier selbst gemacht werden: die Zeilen eines Verlaufs tragen
// unterschiedliche Klassen (rechts-/linksbündig, Absender klein). Chromium bäckt
// beim nativen Merge zweier solcher Absätze die berechneten CSS-Werte der
// Quellzeile als Inline-`style` ein — dieselbe Eigenheit wie an den
// Wrapper-Grenzen (docs/notebook-editor.md, Invarianten 17+18).
// Markup ausschliesslich über die SSoT messages/msg-html.js.

import { getEditEl, placeCaretIn, caretAtBlockStart, caretAtBlockEnd } from './_shared.js';
import {
  closestMsgLine, msgKind, setMsgKind, toggleMsgSide, nextLineKind, createMsgLine,
  MSG_THREAD_CLASS,
} from '../../../messages/msg-html.js';

const BAR_GAP = 4;

function caretLine() {
  const editEl = getEditEl();
  const sel = editEl ? document.getSelection() : null;
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!editEl.contains(range.startContainer)) return null;
  const line = closestMsgLine(range.startContainer, editEl);
  return line ? { editEl, sel, range, line } : null;
}

// Leer = kein Text und kein eingebettetes Element (Bild, Chip) ausser <br>.
function lineIsEmpty(line) {
  if ((line.textContent || '').trim()) return false;
  return !line.querySelector(':not(br)');
}

export const msgThreadMethods = {
  // Dispatcher-Einstieg. true = Event konsumiert.
  _kbMsgThread(e, app) {
    if (e.key === 'Enter' && !e.shiftKey) return this._kbMsgEnter(e, app);
    if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) return this._kbMsgTab(e, app);
    if (e.key === 'Backspace' || e.key === 'Delete') return this._kbMsgMerge(e, app);
    return false;
  },

  // Enter auf einer leeren Zeile verlässt den Verlauf (wie im Gedicht); steht
  // die leere Zeile mittendrin, teilt sie ihn — dazwischen entsteht ein
  // Erzählabsatz. Sonst: Zeile am Caret teilen, die neue Zeile bekommt die Art
  // aus `nextLineKind` (am Zeilenanfang: die Art der Zeile, deren Text wandert).
  _kbMsgEnter(e, app) {
    const hit = caretLine();
    if (!hit) return false;
    const { line, range } = hit;
    e.preventDefault();
    const thread = line.parentNode;
    if (range.collapsed && lineIsEmpty(line)) {
      const out = document.createElement('p');
      out.appendChild(document.createElement('br'));
      const rest = [];
      for (let n = line.nextElementSibling; n; n = n.nextElementSibling) rest.push(n);
      line.remove();
      thread.parentNode.insertBefore(out, thread.nextSibling);
      if (rest.length) {
        const tail = document.createElement('div');
        tail.className = MSG_THREAD_CLASS;
        rest.forEach((n) => tail.appendChild(n));
        out.insertAdjacentElement('afterend', tail);
      }
      if (!thread.children.length) thread.remove();
      placeCaretIn(out);
      app._markEditDirty?.();
      return true;
    }
    if (!range.collapsed) range.deleteContents();
    const atStart = caretAtBlockStart(range, line);
    const tailRange = document.createRange();
    tailRange.setStart(range.startContainer, range.startOffset);
    tailRange.setEnd(line, line.childNodes.length);
    const frag = tailRange.extractContents();
    const next = createMsgLine(atStart ? msgKind(line) : nextLineKind(line));
    next.replaceChildren(frag);
    // Beide Hälften brauchen einen Caret-Slot, wenn der Schnitt am Rand lag.
    if (lineIsEmpty(next)) next.replaceChildren(document.createElement('br'));
    if (lineIsEmpty(line)) line.replaceChildren(document.createElement('br'));
    line.insertAdjacentElement('afterend', next);
    placeCaretIn(next);
    app._markEditDirty?.();
    this._updateMsgBar();
    return true;
  },

  // Tab / Shift+Tab: Seite wechseln (Eingang ↔ Ausgang, siehe toggleMsgSide).
  // Ausserhalb eines Verlaufs bleibt Tab beim Browser.
  _kbMsgTab(e, app) {
    if (app.focusActive) return false;
    const hit = caretLine();
    if (!hit) return false;
    e.preventDefault();
    setMsgKind(hit.line, toggleMsgSide(msgKind(hit.line)));
    app._markEditDirty?.();
    this._updateMsgBar();
    return true;
  },

  // Backspace am Zeilenanfang / Delete am Zeilenende INNERHALB des Verlaufs:
  // selbst verschmelzen, die empfangende Zeile behält ihre Art. Die Grenzen des
  // Verlaufs (erste Zeile, letzte Zeile) bedient `_kbBlockBoundary`.
  _kbMsgMerge(e, app) {
    const hit = caretLine();
    if (!hit || !hit.range.collapsed) return false;
    const { line, range } = hit;
    if (e.key === 'Backspace') {
      const prev = line.previousElementSibling;
      if (!prev || !caretAtBlockStart(range, line)) return false;
      e.preventDefault();
      this._mergeBlocksManually(prev, line);
    } else {
      const next = line.nextElementSibling;
      if (!next || !caretAtBlockEnd(range, line)) return false;
      e.preventDefault();
      this._mergeBlocksManually(line, next);
    }
    app._markEditDirty?.();
    this._updateMsgBar();
    return true;
  },

  // ── Zeilenleiste ─────────────────────────────────────────────────────────

  // Leiste zeigen, solange der Caret in einer Verlaufszeile steht. Verankert
  // rechts über dem Verlauf (nicht über der Zeile — sie soll keinen Text
  // verdecken); läuft der Verlauf oben aus dem Bild, bleibt sie am oberen Rand.
  _updateMsgBar() {
    const app = window.__app;
    const hit = app?.editMode && !app.focusActive ? caretLine() : null;
    if (!hit) {
      if (this.msgBarShow) this.msgBarShow = false;
      this._msgLine = null;
      return;
    }
    this._msgLine = hit.line;
    this.msgBarKind = msgKind(hit.line);
    const rect = hit.line.parentNode.getBoundingClientRect();
    const bar = this.$refs?.msgBar;
    const h = bar?.offsetHeight || 32;
    const vv = window.visualViewport;
    const bandTop = vv ? vv.offsetTop : 0;
    const top = Math.min(
      Math.max(rect.top - h - BAR_GAP, bandTop + BAR_GAP),
      rect.bottom - h,
    );
    this.msgBarX = Math.round(rect.right);
    this.msgBarY = Math.round(top);
    this.msgBarShow = true;
  },

  // Klick in der Leiste. Die Knöpfe tragen @mousedown.prevent: Fokus und Caret
  // bleiben im Editor, weitergeschrieben wird ohne neuen Klick.
  setMsgLineKind(kind) {
    const line = this._msgLine;
    if (!line?.isConnected) return;
    setMsgKind(line, kind);
    this.msgBarKind = kind;
    window.__app?._markEditDirty?.();
  },
};
