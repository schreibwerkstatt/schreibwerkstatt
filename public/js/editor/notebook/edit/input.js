// Teil von notebookEditMethods (siehe Facade edit.js).
import { editorHost, handleEditorCopy, handleEditorCut, handleEditorPaste, mountEditorHtml, stripLektoratMarks } from './_shared.js';
import { countInHtml, replaceInHtml, skipReason } from '../../../utils.js';

export const inputMethods = {

  // Ersetzt eine Textstelle im LIVE-Editor der offenen Edit-Session (Seiten-Chat
  // „Übernehmen"/„Rückgängig" im Edit-Modus). Ein Server-Write daneben liesse das
  // contenteditable auf dem alten Stand stehen, und der nächste Autosave
  // überschriebe die Übernahme still — darum landet die Ersetzung hier im DOM
  // und geht den normalen Weg: Dirty → Draft → Autosave, Undo-fähig.
  //
  // Dieselben Guards wie der Server-Pfad (chat.js), gegen die Save-Normalform
  // (`stripLektoratMarks`): 0 Treffer → 'notFound', >1 → 'ambiguous', No-Op von
  // `replaceInHtml` → `skipReason`. Mount über `mountEditorHtml` (dieselbe
  // Pipeline wie Undo-Restore und Merge-Spiegel). Notebook-only: im Fokusmodus
  // löst `_getEditEl` auf den Fokus-Container auf — dort wird nichts angefasst.
  // Liefert { ok: true } oder { ok: false, reason }.
  _applyTextReplacement(original, replacement) {
    const app = editorHost();
    if (!app?.editMode) return { ok: false, reason: 'notEditing' };
    if (app.focusActive) return { ok: false, reason: 'focus' };
    const el = this._getEditEl();
    if (!el) return { ok: false, reason: 'notEditing' };
    const html = stripLektoratMarks(el.innerHTML);
    const n = countInHtml(html, original);
    if (n === 0) return { ok: false, reason: 'notFound' };
    if (n > 1) return { ok: false, reason: 'ambiguous' };
    const next = replaceInHtml(html, original, replacement);
    if (next === html) return { ok: false, reason: skipReason(html, original) };
    // Vorher-Stand als eigenen Undo-Schritt einfrieren (offene Tipp-Serie
    // inklusive), sonst fasste der Debounce Tippen + Übernahme zusammen.
    this._historyPushNow?.();
    const scrollTop = el.scrollTop;
    mountEditorHtml(el, next);
    el.scrollTop = scrollTop;
    this._markEditDirty();
    return { ok: true };
  },

  // Einfügen/Ausschneiden sind eigene Undo-Schritte: Vorher-Stand einfrieren
  // (offene Tipp-Serie inklusive), Nachher-Stand sofort — sonst fasst der
  // Debounce Tippen + Einfügen zu einem Schritt zusammen.
  _onEditPaste(e) {
    this._historyPushNow?.();
    if (handleEditorPaste(e)) { this._markEditDirty(); this._historyPushNow?.(); }
  },


  _onEditCopy(e) { handleEditorCopy(e); },


  _onEditCut(e) {
    this._historyPushNow?.();
    if (handleEditorCut(e)) { this._markEditDirty(); this._historyPushNow?.(); }
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
