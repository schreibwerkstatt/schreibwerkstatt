// editorToolbarCard: Enter in Checkbox-Liste, Gedicht und Bildunterschrift (aus dem Keydown-
// Dispatcher toolbar/keydown.js). Beide laufen VOR dem Focus-Hard-Stop, also
// auch im Fokusmodus der SPA — dort legt Enter eine neue leere Zeile hinter der
// aktuellen an (keine Teilung am Caret), und eine leere Zeile verlässt den Block
// nach hinten, die Folgezeilen bleiben darin; siehe die `focusActive`-Zweige. `this` = Sub-Komponente (editorToolbarCard).

import { getEditEl, placeCaretIn, findTodoLi, findPoemP, findFigcaption, findAncestor, caretAtBlockStart, _brLeftOfCaret, historyStep } from './_shared.js';
import { createTodoItem, TODO_TEXT_SEL } from '../../shared/todo-html.js';
import { dropEmptyInline } from '../split-html.js';
import { deleteRangeClean, splitWrapperAtLine } from '../line-merge.js';

const isBlankText = (el) => !(el?.textContent || '').trim() && !el?.querySelector?.('img, input');

// Kinder, die eine Zeile im Zitat bilden (Block), statt in einer zu stehen.
const QUOTE_BLOCK_CHILD = /^(P|H[1-6]|UL|OL|BLOCKQUOTE|PRE|DIV|FIGURE|TABLE|HR)$/;
const hasBareInline = (bq) => Array.from(bq.childNodes).some((n) => (n.nodeType === 3 ? n.data.trim()
  : n.nodeType === 1 && !QUOTE_BLOCK_CHILD.test(n.tagName)));

// Lose Inline-Läufe eines Zitats je in ein `<p>` fassen. Der Caret bleibt an
// seinem Textknoten — Verschieben setzte die Range sonst auf den Elternknoten.
function wrapBareInline(bq, sel) {
  const r = sel.getRangeAt(0);
  const at = [r.startContainer, r.startOffset];
  let run = null;
  for (const n of Array.from(bq.childNodes)) {
    if (n.nodeType === 1 && QUOTE_BLOCK_CHILD.test(n.tagName)) { run = null; continue; }
    if (!run) {
      if (n.nodeType === 3 && !n.data.trim()) { n.remove(); continue; }
      run = document.createElement('p');
      bq.insertBefore(run, n);
    }
    run.appendChild(n);
  }
  if (bq.contains(at[0]) && at[0] !== bq) {
    const nr = document.createRange();
    nr.setStart(at[0], Math.min(at[1], at[0].nodeType === 3 ? at[0].length : at[0].childNodes.length));
    nr.collapse(true);
    sel.removeAllRanges();
    sel.addRange(nr);
  } else {
    // Caret stand direkt im Zitat (zwischen Kindern): ans Ende der letzten Zeile.
    const last = bq.lastElementChild;
    if (last) placeCaretAtEnd(last, sel);
  }
}

function placeCaretAtEnd(el, sel) {
  const nr = document.createRange();
  nr.selectNodeContents(el);
  nr.collapse(false);
  sel.removeAllRanges();
  sel.addRange(nr);
}

export const keydownEnterMethods = {
  // Struktur-Taste als eigener Undo-Schritt (toolbar/_shared.js#historyStep):
  // Cmd+Z nimmt genau diese Umwandlung zurück — weder das Getippte davor noch
  // das danach.
  _structStep(app) {
    historyStep(app);
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

  // Enter in der Bildunterschrift (`<figure> > <figcaption>`): verlässt die
  // Abbildung nach hinten. Der Default teilte die Legende in eine zweite
  // `<figcaption>` — eine Abbildung hat aber genau eine. Ziel ist ein leerer
  // Absatz direkt hinter dem `<figure>` (den `ensureSlotAfter` beim Einfügen
  // meist schon angelegt hat), sonst ein neuer. Der Legendentext bleibt, wie er
  // ist; einen Zeilenumbruch darin gibt es mit Shift+Enter (`_kbSoftBreak`).
  // Notebook-only: hängt hinter dem Focus-Hard-Stop.
  _kbFigureEnter(e, app) {
    if (!(e.key === 'Enter' && !e.shiftKey)) return false;
    const editEl = getEditEl();
    const sel = editEl ? document.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return false;
    const cap = findFigcaption(sel.getRangeAt(0).startContainer, editEl);
    const fig = cap?.closest('figure');
    if (!fig || !editEl.contains(fig)) return false;
    e.preventDefault();
    this._structStep(app);
    let next = fig.nextElementSibling;
    if (!(next?.tagName === 'P' && isBlankText(next))) {
      next = document.createElement('p');
      next.appendChild(document.createElement('br'));
      fig.insertAdjacentElement('afterend', next);
    }
    placeCaretIn(next);
    app._markEditDirty?.();
    return true;
  },

  // Enter auf einer leeren Zitatzeile (`blockquote > p`): Zitat dort teilen bzw.
  // auf der letzten Zeile verlassen — dieselbe Doppel-Enter-Regel wie Gedicht,
  // Checkbox-Liste und Verlauf. Der Browser-Default hängt im `<blockquote>`
  // sonst endlos leere Absätze an. Die Hälfte dahinter behält den Quellen-
  // Zeiger (`data-src`, splitWrapperAtLine). Notebook-only: hinter dem
  // Focus-Hard-Stop.
  // Ein Zitat aus Import-Markup trägt seinen Text oft ohne `<p>`
  // (`<blockquote>Text</blockquote>`): der Browser-Default teilte dann das
  // Zitat selbst, jede Zeile würde ein eigenes. Vorher die losen Inline-Läufe
  // in Absätze fassen, danach greift dieselbe Regel wie sonst.
  _kbQuoteEnter(e, app) {
    if (!(e.key === 'Enter' && !e.shiftKey)) return false;
    const editEl = getEditEl();
    const sel = editEl ? document.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return false;
    const bare = findAncestor(sel.getRangeAt(0).startContainer, editEl, 'blockquote');
    if (bare && hasBareInline(bare)) {
      this._structStep(app);
      wrapBareInline(bare, sel);
      app._markEditDirty?.();
    }
    const p = findAncestor(sel.getRangeAt(0).startContainer, editEl, 'blockquote > p');
    if (!p || !isBlankText(p)) return false;
    e.preventDefault();
    this._structStep(app);
    placeCaretIn(splitWrapperAtLine(p, p.parentNode));
    app._markEditDirty?.();
    return true;
  },

  // Enter auf der leeren letzten Zeile eines Code-Blocks (`<pre>`, Import-/Paste-
  // Markup): die Leerzeile fällt weg, ein Absatz hinter dem Block nimmt den
  // Caret. Leerzeilen mitten im Code bleiben (dort ist Enter ein Umbruch).
  // Diagramme sind `contenteditable=false` und erreichen den Handler nicht.
  _kbPreEnter(e, app) {
    if (!(e.key === 'Enter' && !e.shiftKey)) return false;
    const editEl = getEditEl();
    const sel = editEl ? document.getSelection() : null;
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const pre = findAncestor(range.startContainer, editEl, 'pre');
    if (!pre || !_brLeftOfCaret(sel)) return false;
    const after = document.createRange();
    after.setStart(range.startContainer, range.startOffset);
    after.setEnd(pre, pre.childNodes.length);
    if (after.toString().trim()) return false;
    e.preventDefault();
    this._structStep(app);
    after.deleteContents();
    // Leerzeile (das <br> links vom Caret) samt Leerraum am Ende entfernen —
    // auch innerhalb eines `<code>` (übliches Import-Markup `<pre><code>`).
    const tailHost = pre.lastElementChild?.tagName === 'CODE' && !pre.lastElementChild.nextSibling
      ? pre.lastElementChild : pre;
    for (let n = tailHost.lastChild; n && (n.nodeName === 'BR' || (n.nodeType === 3 && !n.data.trim())); n = tailHost.lastChild) {
      n.remove();
    }
    const out = document.createElement('p');
    out.appendChild(document.createElement('br'));
    pre.insertAdjacentElement('afterend', out);
    if (!(pre.textContent || '').trim()) pre.remove();
    placeCaretIn(out);
    app._markEditDirty?.();
    return true;
  },

  // Enter am Anfang eines Zwischentitels mit Text: davor entsteht ein leerer
  // ABSATZ, der Caret bleibt am Titelanfang. Der Default legte dort einen leeren
  // Titel an — Gliederung ohne Text, die im Export als leere Überschrift landet.
  // Wer am Titelanfang Enter drückt, will Platz für Text davor. Enter mitten im
  // Titel teilt ihn weiterhin (Default), am Titelende entsteht ohnehin ein
  // Absatz (`defaultParagraphSeparator`). Notebook-only: hinter dem
  // Focus-Hard-Stop.
  _kbHeadingStartEnter(e, app) {
    if (!(e.key === 'Enter' && !e.shiftKey)) return false;
    const editEl = getEditEl();
    const sel = editEl ? document.getSelection() : null;
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false;
    const range = sel.getRangeAt(0);
    const h = findAncestor(range.startContainer, editEl, 'h1,h2,h3,h4,h5,h6');
    if (!h || isBlankText(h) || !caretAtBlockStart(range, h)) return false;
    e.preventDefault();
    this._structStep(app);
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    h.insertAdjacentElement('beforebegin', p);
    placeCaretIn(h);
    app._markEditDirty?.();
    return true;
  },
};
