// editorToolbarCard: Enter in Checkbox-Liste und Gedicht (aus dem Keydown-
// Dispatcher toolbar/keydown.js). Beide laufen VOR dem Focus-Hard-Stop, also
// auch im Fokusmodus der SPA — dort legt Enter eine neue leere Zeile hinter der
// aktuellen an (keine Teilung am Caret), und eine leere Zeile verlässt den Block
// nach hinten, die Folgezeilen bleiben darin; siehe die `focusActive`-Zweige. `this` = Sub-Komponente (editorToolbarCard).

import { getEditEl, placeCaretIn, findTodoLi, findPoemP, caretAtBlockStart } from './_shared.js';
import { createTodoItem, TODO_TEXT_SEL } from '../../shared/todo-html.js';
import { dropEmptyInline } from '../split-html.js';
import { deleteRangeClean, splitWrapperAtLine } from '../line-merge.js';

const isBlankText = (el) => !(el?.textContent || '').trim() && !el?.querySelector?.('img, input');

export const keydownEnterMethods = {
  // Struktur-Taste als eigener Undo-Schritt: Vorher-Stand einfrieren (offene
  // Tipp-Serie inklusive), damit Cmd+Z genau diese Umwandlung zurücknimmt und
  // nicht das Getippte davor mit. Den Nachher-Stand friert `_markEditDirty` über
  // den Debounce ein; das nächste Tippen beginnt damit einen neuen Schritt.
  // Im Fokusmodus nicht — dort hängt die Historie an dessen `input`-Pfad.
  _structStep(app) {
    if (!app.focusActive) app._historyPushNow?.();
  },

  // Enter in einer Checkbox-Zeile.
  //   • Auswahl wird zuerst gelöscht (über Blockgrenzen selbst, s. line-merge.js).
  //   • Leere Zeile: Liste dort teilen — ein Absatz steht zwischen den Hälften
  //     (letzte Zeile: Liste verlassen).
  //   • Caret am Zeilenanfang: neue leere Zeile DARÜBER, der Text bleibt.
  //   • Sonst: Zeile am Caret teilen, der Rest wandert in die neue Zeile.
  // Markup ausschliesslich über editor/shared/todo-html.js.
  _kbTodoEnter(e, app) {
    if (!(e.key === 'Enter' && !e.shiftKey)) return false;
    const editEl = getEditEl();
    const sel = editEl ? document.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return false;
    let li = findTodoLi(sel.getRangeAt(0).startContainer, editEl);
    if (!li) return false;
    e.preventDefault();
    this._structStep(app);
    let range = sel.getRangeAt(0);
    if (!range.collapsed && !app.focusActive) {
      if (!deleteRangeClean(editEl)) range.deleteContents();
      range = sel.getRangeAt(0);
      li = findTodoLi(range.startContainer, editEl);
      if (!li) { app._markEditDirty?.(); return true; }
    }
    const span = li.querySelector(TODO_TEXT_SEL);
    if (isBlankText(span || li)) {
      placeCaretIn(splitWrapperAtLine(li, li.parentNode, { keepTail: !app.focusActive }));
    } else if (app.focusActive || !span) {
      const newLi = createTodoItem();
      li.parentNode.insertBefore(newLi, li.nextSibling);
      placeCaretIn(newLi.querySelector(TODO_TEXT_SEL));
    } else if (caretAtBlockStart(range, span)) {
      li.parentNode.insertBefore(createTodoItem(), li);
      placeCaretIn(span);
    } else {
      const tailRange = document.createRange();
      tailRange.setStart(range.startContainer, range.startOffset);
      tailRange.setEnd(span, span.childNodes.length);
      const frag = tailRange.extractContents();
      const newLi = createTodoItem();
      const newSpan = newLi.querySelector(TODO_TEXT_SEL);
      newSpan.replaceChildren(frag);
      // Ein Schnitt am Rand einer Formatierung lässt leere Hüllen zurück; beide
      // Hälften brauchen dann einen Caret-Slot.
      dropEmptyInline(span);
      dropEmptyInline(newSpan);
      if (isBlankText(newSpan)) newSpan.replaceChildren(document.createElement('br'));
      if (isBlankText(span)) span.replaceChildren(document.createElement('br'));
      li.parentNode.insertBefore(newLi, li.nextSibling);
      placeCaretIn(newSpan);
    }
    app._markEditDirty?.();
    return true;
  },

  // Enter auf einer leeren Gedichtzeile (`div.poem > p`): Gedicht dort teilen,
  // ein Absatz steht zwischen den Hälften; auf der letzten Zeile verlässt es das
  // Gedicht. Der erste Enter auf einer Textzeile erzeugt per Browser-Default die
  // leere Zeile, der zweite trifft sie — wie in Checkbox-Liste und Verlauf.
  _kbPoemEnter(e, app) {
    if (!(e.key === 'Enter' && !e.shiftKey)) return false;
    const editEl = getEditEl();
    const sel = editEl ? document.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return false;
    const p = findPoemP(sel.getRangeAt(0).startContainer, editEl);
    if (!p || (p.textContent || '').trim()) return false;
    e.preventDefault();
    this._structStep(app);
    placeCaretIn(splitWrapperAtLine(p, p.parentNode, { keepTail: !app.focusActive }));
    app._markEditDirty?.();
    return true;
  },
};
