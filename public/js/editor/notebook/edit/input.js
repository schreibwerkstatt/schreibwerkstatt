// Teil von notebookEditMethods (siehe Facade edit.js).
import { editorHost, handleEditorCopy, handleEditorCut, handleEditorPaste, stripLektoratMarks } from './_shared.js';
import { countInHtml, replaceInHtmlRich, richSkipReason } from '../../../utils.js';
import { normalizeQuotesInHtml } from '../../shared/quote-normalize/walk.js';
import { deleteRangeClean } from '../line-merge.js';
import { TABLE_SEL, markTablesAtomic } from '../../../table/table-html.js';
import { DIAGRAM_SEL, markDiagramsAtomic } from '../../../diagram/mermaid-html.js';
import { markFiguresAtomic } from '../../../figure/figure-html.js';
import { markCitesAtomic } from '../../../sources/cite-html.js';
import { markXrefsAtomic } from '../../../xrefs/xref-html.js';
import { closestMsgLine, createMsgLine, msgKind } from '../../../messages/msg-html.js';
import { TODO_TEXT_SEL, createTodoItem } from '../../shared/todo-html.js';
import { ensureSlotAfter } from '../toolbar/_shared.js';
import { patchEditorHtml } from './patch-html.js';
import { captureBlockCaret, restoreBlockCaret } from '../../shared/block-caret.js';
import { mapCaretOffset } from '../../shared/edit-history.js';

// Blöcke, die ein Ablegen in einen Absatz/Titel hineinsetzen kann.
const DROPPED_BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, div';

// Caret-Block zu einem `captureBlockCaret`-Ergebnis (gleiche Suche wie
// `restoreBlockCaret`), oder null.
function caretBlockOf(root, caret) {
  let block = caret.bid ? [...root.children].find((c) => c.getAttribute('data-bid') === caret.bid) || null : root.firstElementChild;
  for (let i = 0; i < caret.steps && block?.nextElementSibling; i++) block = block.nextElementSibling;
  return block;
}

function placeCaretAtEnd(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

export const inputMethods = {

  // Ersetzt eine Textstelle im LIVE-Editor der offenen Edit-Session (Seiten-Chat
  // „Übernehmen"/„Rückgängig" im Edit-Modus). Ein Server-Write daneben liesse das
  // contenteditable auf dem alten Stand stehen, und der nächste Autosave
  // überschriebe die Übernahme still — darum landet die Ersetzung hier im DOM
  // und geht den normalen Weg: Dirty → Draft → Autosave, Undo-fähig.
  //
  // Dieselben Guards wie der Server-Pfad (chat.js), gegen die Save-Normalform
  // (`stripLektoratMarks`): 0 Treffer → 'notFound', >1 → 'ambiguous', No-Op von
  // `replaceInHtmlRich` → `richSkipReason` (Ersatz darf *kursiv*/**fett** und eine
  // Absatzteilung tragen). `quoteStyle` (optional, Stil des Buchs): danach die
  // Anführungszeichen ziehen wie der Server-Pfad (`_loadApplyAndSave`) — sonst
  // blieben gerade `"` der KI im Text. Eingehängt blockweise über
  // `_mountAcceptedHtml` (Caret, Scroll und Fokus bleiben). Notebook-only: im Fokusmodus
  // löst `_getEditEl` auf den Fokus-Container auf — dort wird nichts angefasst.
  // Liefert { ok: true } oder { ok: false, reason }.
  _applyTextReplacement(original, replacement, { quoteStyle = null } = {}) {
    const app = editorHost();
    if (!app?.editMode) return { ok: false, reason: 'notEditing' };
    if (app.focusActive) return { ok: false, reason: 'focus' };
    const el = this._getEditEl();
    if (!el) return { ok: false, reason: 'notEditing' };
    const html = stripLektoratMarks(el.innerHTML);
    const n = countInHtml(html, original);
    if (n === 0) return { ok: false, reason: 'notFound' };
    if (n > 1) return { ok: false, reason: 'ambiguous' };
    let next = replaceInHtmlRich(html, original, replacement);
    if (next === html) return { ok: false, reason: richSkipReason(html, original, replacement) };
    if (quoteStyle) next = normalizeQuotesInHtml(next, quoteStyle);
    // Vorher-Stand als eigenen Undo-Schritt einfrieren (offene Tipp-Serie
    // inklusive), sonst fasste der Debounce Tippen + Übernahme zusammen.
    this._historyPushNow?.();
    this._mountAcceptedHtml(el, html, next);
    this._markEditDirty();
    return { ok: true };
  },

  // Lektorat-Befunde im LIVE-Editor übernehmen (Befundliste im Edit-Modus,
  // editor/lektorat-live.js). Gleicher Ersetzungs-Kern wie «Korrekturen
  // speichern» (`_applyCorrections`: Klartext, sequenziell), aber wie
  // `_applyTextReplacement` im DOM statt per Server-Write — sonst überschriebe
  // der nächste Autosave die Übernahme. Eine Stelle, die im Live-Text mehrfach
  // steht, wird übersprungen ('ambiguous', wie im Abschnitts-Chat): beim
  // Schreiben entsteht so leicht ein zweites Vorkommen vor der gemeinten Stelle.
  // Alle Befunde zusammen sind EIN Undo-Schritt. Notebook-only. Liefert
  // { applied, skipped } oder { applied: [], skipped: [], reason }.
  _applyLektoratInEditor(fehler, { quoteStyle = null } = {}) {
    const app = editorHost();
    if (!app?.editMode) return { applied: [], skipped: [], reason: 'notEditing' };
    if (app.focusActive) return { applied: [], skipped: [], reason: 'focus' };
    const el = this._getEditEl();
    if (!el) return { applied: [], skipped: [], reason: 'notEditing' };
    const html = stripLektoratMarks(el.innerHTML);
    const skipped = [];
    let next = app._applyCorrections(html, fehler, skipped, { checkAmbiguous: true });
    if (next === html) return { applied: [], skipped };
    if (quoteStyle) next = normalizeQuotesInHtml(next, quoteStyle);
    this._historyPushNow?.();
    this._mountAcceptedHtml(el, html, next);
    this._markEditDirty();
    // Übernahme sofort speichern, nicht erst nach der Autosave-Tipp-Pause.
    // Läuft schon ein Save, bleibt der eben geplante Autosave-Timer als Netz.
    if (!app.editSaving) this.quickSave('lektorat');
    const skippedSet = new Set(skipped.map(s => s.f));
    return { applied: fehler.filter(f => !skippedSet.has(f)), skipped };
  },

  // Übernommenen Stand einhängen (Abschnitts-Chat, Lektorat): nur die
  // geänderten Blöcke tauschen (edit/patch-html.js), Scroll halten, und der
  // Caret bleibt, wo er war — im selben Block, um die Längenänderung davor
  // verschoben. Stand er im Editor, geht der Fokus dorthin zurück: nach dem
  // Klick auf «Übernehmen» liegt er sonst auf dem Knopf, und Weitertippen
  // bräuchte erst einen Klick in den Text.
  _mountAcceptedHtml(el, oldHtml, nextHtml) {
    const caret = captureBlockCaret(el);
    const oldText = caret ? caretBlockOf(el, caret)?.textContent ?? null : null;
    const scrollTop = el.scrollTop;
    patchEditorHtml(el, oldHtml, nextHtml);
    if (caret) {
      el.focus({ preventScroll: true });
      const block = caretBlockOf(el, caret);
      if (block && oldText != null) caret.offset = mapCaretOffset(oldText, block.textContent || '', caret.offset);
      restoreBlockCaret(el, caret);
    }
    el.scrollTop = scrollTop;
  },

  // Einfügen/Ausschneiden sind eigene Undo-Schritte: Vorher-Stand einfrieren
  // (offene Tipp-Serie inklusive), Nachher-Stand sofort — sonst fasst der
  // Debounce Tippen + Einfügen zu einem Schritt zusammen.
  //
  // Tabellen im Clipboard kommen ausserhalb des Fokusmodus als Tabellen an
  // (sanitizePasteHtml normalisiert sie über table-html.js) und werden danach
  // wie jede Tabelle im Editor atomar (`_adoptPastedBlocks`).
  _onEditPaste(e) {
    this._historyPushNow?.();
    const tables = !editorHost()?.focusActive;
    if ((tables && this._pasteLinesIntoLineBlock(e)) || handleEditorPaste(e, { tables })) {
      if (tables) this._adoptPastedBlocks();
      this._markEditDirty();
      this._historyPushNow?.();
    }
  },

  // Mehrere Zeilen in eine Zeile, die keine Absätze tragen darf: Bildunter-
  // schrift, Checkbox-Zeile, Verlaufszeile. `insertHTML` setzte dort `<p>` in die
  // Legende bzw. das `<li>` und bäckt den Stil des Ziels als Inline-`style` ein.
  // Stattdessen je Zielblock: Legende → eine Zeile (mit Leerzeichen verbunden),
  // Checkbox-Liste → je Zeile ein Eintrag, Verlauf → je Zeile eine Zeile
  // derselben Art. Eine einzelne Zeile bleibt beim normalen Einfügen (mit
  // Auszeichnung). Rückgabe true = eingefügt.
  _pasteLinesIntoLineBlock(e) {
    const editEl = this._getEditEl();
    const sel = document.getSelection();
    const cd = e.clipboardData;
    if (!editEl || !cd || !sel || sel.rangeCount === 0) return false;
    const start = sel.getRangeAt(0).startContainer;
    if (!editEl.contains(start)) return false;
    const el = start.nodeType === 3 ? start.parentElement : start;
    const cap = el?.closest('figcaption');
    const todo = el?.closest(TODO_TEXT_SEL);
    const line = closestMsgLine(start, editEl);
    if (!cap && !todo && !line) return false;
    const lines = (cd.getData('text/plain') || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) return false;
    e.preventDefault();
    if (!sel.isCollapsed && !deleteRangeClean(editEl)) document.execCommand('delete');
    if (cap) {
      document.execCommand('insertText', false, lines.join(' '));
      return true;
    }
    document.execCommand('insertText', false, lines[0]);
    let prev = todo ? todo.closest('li') : line;
    let last = null;
    for (const text of lines.slice(1)) {
      const row = todo ? createTodoItem() : createMsgLine(msgKind(line));
      const host = todo ? row.querySelector(TODO_TEXT_SEL) : row;
      host.replaceChildren(document.createTextNode(text));
      prev.insertAdjacentElement('afterend', row);
      prev = row;
      last = host;
    }
    if (last) placeCaretAtEnd(last);
    return true;
  },

  // Frisch eingefügte Tabellen, Diagramme, Abbildungen, Quellen-Chips und
  // Querverweise tragen noch kein `contenteditable` (der Mount setzt es, nicht
  // das Clipboard). `insertHTML` kann beim Einfügen berechnete Werte als
  // Inline-`style` einbacken — die fliegen hier raus, bevor sie in die
  // Persistenz gelangen. Hinter jedem neuen Block ein Schreib-Absatz, wie nach
  // dem Dialog.
  _adoptPastedBlocks() {
    const editEl = this._getEditEl();
    if (!editEl) return;
    // Neu = Tabelle/Diagramm ohne Laufzeit-Attribut, Abbildung ohne Block-ID.
    const fresh = Array.from(editEl.querySelectorAll(`${TABLE_SEL}, ${DIAGRAM_SEL}, figure`))
      .filter((t) => (t.tagName === 'FIGURE' ? !t.hasAttribute('data-bid') : !t.hasAttribute('contenteditable')));
    for (const t of fresh) {
      t.removeAttribute('style');
      t.querySelectorAll('[style]').forEach((el) => el.removeAttribute('style'));
    }
    markTablesAtomic(editEl);
    markDiagramsAtomic(editEl);
    markFiguresAtomic(editEl);
    markCitesAtomic(editEl);
    markXrefsAtomic(editEl);
    for (const t of fresh) if (t.parentNode === editEl) ensureSlotAfter(t);
  },


  _onEditCopy(e) { handleEditorCopy(e); },


  // Ziehen und Ablegen im Editor (`insertFromDrop`) läuft über den Browser-
  // Default: der verschiebt die Auswahl, bäckt dabei aber die berechneten Werte
  // der Quelle als Inline-`style` ein und setzt aus einer Überschrift gezogenen
  // Text als `<h2>` mitten in den Absatz. Danach hier aufräumen, nur in den
  // Blöcken, die die abgelegte Auswahl berührt: `style` fällt, ein Block im
  // Absatz/Titel wird zu seinem Inhalt. Notebook-only (Fokusmodus: Spec
  // focus-editor.md, nicht angefasst).
  _onEditInput(e) {
    if (e?.inputType !== 'insertFromDrop' || editorHost()?.focusActive) return;
    const editEl = this._getEditEl();
    const sel = document.getSelection();
    if (!editEl || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const top = (n) => {
      let cur = n;
      while (cur && cur.parentNode !== editEl) cur = cur.parentNode;
      return cur;
    };
    const first = top(range.startContainer);
    const last = top(range.endContainer);
    if (!first || !last) return;
    for (let b = first; b; b = b.nextSibling) {
      if (b.nodeType === 1) {
        b.removeAttribute('style');
        b.querySelectorAll('[style]').forEach((el) => el.removeAttribute('style'));
        if (/^(P|H[1-6])$/.test(b.tagName)) {
          b.querySelectorAll(DROPPED_BLOCK_SEL).forEach((inner) => inner.replaceWith(...inner.childNodes));
        }
      }
      if (b === last) break;
    }
  },


  // Notebook (nicht Fokusmodus): eine Auswahl über Blockgrenzen löscht der
  // Editor selbst (line-merge.js#deleteRangeClean) — `execCommand('delete')`
  // bäckt dort Inline-`style` ein.
  _onEditCut(e) {
    this._historyPushNow?.();
    const deleteSelection = editorHost()?.focusActive ? null : () => deleteRangeClean(this._getEditEl());
    if (handleEditorCut(e, { deleteSelection })) { this._markEditDirty(); this._historyPushNow?.(); }
  },


  _markEditDirty() {
    const app = editorHost();
    if (!app?.editMode) return;
    app.editDirty = true;
    this._scheduleDraftSave();
    this._scheduleAutosave();
    this._historyPushSoon?.();
    this._scrollEditCaretIntoView();
    // Steuerzeichen-Overlay neu vermessen: programmatische Mutationen (STT,
    // Paste, Cut, Toolbar) feuern KEIN `input`-Event, an dem die Marks-Schicht
    // sonst hängt — ohne diesen Aufruf bleibt die ↵/¶-Dekoration während des
    // Diktats stehen und entkoppelt sich vom Text. rAF-coalesced/idempotent,
    // daher für den Tipp-Pfad (feuert ohnehin `input`) ein No-op.
    this._scheduleFormatMarks?.();
  },


  // Hält den Caret im sichtbaren Bereich des Edit-Felds. Das contenteditable ist
  // sein eigener Scroll-Container (max-height + overflow-y:auto), darum nicht
  // scrollIntoView (das würde die ganze Seite scrollen), sondern den eigenen
  // scrollTop nachziehen. Nur ein Nudge, wenn der Caret über/unter den
  // sichtbaren Rand rutscht — scrollt der User bewusst weg (ohne zu tippen),
  // bleibt das unberührt (kein Input-Event). Aufrufer: `_markEditDirty`
  // (Tippen/Paste/Toolbar — Sicherheitsnetz) und STT (programmatischer Insert,
  // bei dem der Browser NICHT automatisch nachzieht). `rect` optional: STT
  // misst den eingefügten Knoten direkt, sonst wird der Live-Caret vermessen.
  _scrollEditCaretIntoView(rect) {
    const el = this._getEditEl();
    if (!el) return;
    let r = rect;
    if (!r) {
      const sel = document.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer) && el !== range.commonAncestorContainer) return;
      r = range.getBoundingClientRect();
      // Kollabierte Range in einem frisch erzeugten leeren `<p><br></p>` liefert
      // in Chromium {top:0, bottom:0, height:0}. Greift dann der Block-Fallback
      // nicht, bricht der Nudge beim Enter ab und der Editor zieht erst beim
      // ersten getippten Zeichen nach -> sichtbarer Scroll-Sprung. Stattdessen
      // den umschliessenden Block vermessen (wie der STT-Pfad mit explizitem
      // Knoten-Rect), damit der neue Absatz schon beim Enter mitscrollt.
      if (!r || (!r.height && !r.top && !r.bottom)) {
        let node = range.commonAncestorContainer;
        if (node && node.nodeType === 3) node = node.parentNode;
        while (node && node.parentNode && node.parentNode !== el) node = node.parentNode;
        if (node && node !== el && node.getBoundingClientRect) r = node.getBoundingClientRect();
      }
    }
    if (!r || (!r.height && !r.top && !r.bottom)) return; // kein verlässliches Rect
    const host = el.getBoundingClientRect();
    const margin = 28;
    if (r.bottom > host.bottom - margin) {
      el.scrollTop += r.bottom - (host.bottom - margin);
    } else if (r.top < host.top + margin) {
      el.scrollTop -= (host.top + margin) - r.top;
    }
  },
};
