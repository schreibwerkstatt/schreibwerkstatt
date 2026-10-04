// Teil von bookEditorCard (Facade cards/book-editor-card.js): Undo/Redo pro
// Seite über den geteilten Kern editor/shared/edit-history.js (derselbe wie
// Notebook- und Fokus-Editor, eigene Instanzen). Methoden in den Card-Scope
// gespreadet (gemeinsames `this`).
//
// WARUM NICHT DAS NATIVE UNDO DES BROWSERS:
//   1. Find/Replace mutiert per Range (deleteContents/insertNode) — das landet
//      nicht im Browser-Stack und entwertet ihn: danach nimmt Strg+Z weder den
//      Replace noch das Tippen davor zurück.
//   2. Chromium/WebKit führen ein überzähliges Strg+Z auf einer bereits
//      verlassenen (inaktiven) Seite aus. Deren DOM trägt Anzeige-Artefakte
//      (gerendertes Mermaid-SVG, Nummern-Badges) — über `input` wäre das SVG in
//      `block.html` und von dort ins Manuskript gelaufen.
//   3. WebKit fasst eine lange Tipp-Strecke zu EINEM Undo-Schritt zusammen
//      (siehe Kopf von edit-history.js).
// Der native Stack wird darum nie bedient: Strg+Z/Strg+Shift+Z/Strg+Y
// (keydown) und `beforeinput` mit historyUndo/historyRedo (Bearbeiten-Menü,
// Kontextmenü, iOS-Schütteln) werden abgefangen und hierher umgeleitet.
//
// Pro Seite, nicht streamweit: ein Undo über Seitengrenzen müsste Blöcke
// aktivieren und scrollen und bräche „genau ein aktiver Block".
//
// INVARIANTE Snapshots: nur vom AKTIVEN Block (der ist artefaktfrei, siehe
// _syncBlockDiagrams) oder von `block.html` (bereinigt). `getRoot` liefert für
// inaktive Seiten null, ausser während `_historyRecordInactive` einen
// losgelösten Container aus `block.html` vorlegt.

import { createEditHistory } from '../../editor/shared/edit-history.js';
import { matchHistoryCommand } from '../../editor/shared/shortcuts.js';

export const bookEditorHistoryMethods = {
  _historyFor(pageId, { create = false } = {}) {
    const all = (this._histories ||= new Map());
    let h = all.get(pageId);
    if (h || !create) return h || null;
    h = createEditHistory({
      getRoot: () => {
        if (this._histCaptureEl && this._histCapturePageId === pageId) return this._histCaptureEl;
        if (this.activePageId !== pageId) return null;
        return this._blockEl(pageId);
      },
      // Wie _mountBlockEl/_maybeRehydrate: der Bucheditor mountet roh, der
      // aktive Block trägt keine Artefakte, die neu zu stempeln wären.
      mountHtml: (el, html) => { el.innerHTML = html; },
      // Dirty/Autosave setzt das vom Kern dispatchte `input` über
      // _onBlockInput — hier nur, was davon nicht abgedeckt ist.
      onRestored: () => {
        if (this.commentRailVisible) this._scheduleCommentRecompute();
      },
      onChange: () => { this._histTick++; },
    });
    all.set(pageId, h);
    return h;
  },

  _blockEl(pageId) {
    return this.$root?.querySelector(`[data-book-editor-page="${pageId}"]`) || null;
  },

  // Beim Aktivieren (DOM bereits artefaktfrei): Baseline oder — bei schon
  // vorhandenem Verlauf — Anschluss-Snapshot (Dedupe gegen die Spitze).
  _historyOnActivate(pageId, el) {
    const h = this._historyFor(pageId);
    if (h) h.pushNow();
    else this._historyFor(pageId, { create: true }).reset(el.innerHTML);
  },

  // VOR dem Wechsel von activePageId: offenen Debounce der verlassenen Seite
  // einlösen, solange getRoot sie noch liefert — sonst verpufft die letzte
  // Tipp-Strecke als Undo-Schritt.
  _historyOnDeactivate(pageId) {
    this._historyFor(pageId)?.pushNow();
  },

  // Externe Mutation einer inaktiven Seite (Find/Replace): als Schritt in ihren
  // Verlauf, sonst springt das erste Undo nach der Reaktivierung zwei Stände
  // zurück und nimmt den Replace stillschweigend mit.
  _historyRecordInactive(block) {
    const h = this._historyFor(block.pageId);
    if (!h) return;
    const el = document.createElement('div');
    el.innerHTML = block.html;
    this._histCaptureEl = el;
    this._histCapturePageId = block.pageId;
    try { h.pushNow(); } finally {
      this._histCaptureEl = null;
      this._histCapturePageId = null;
    }
  },

  _historyPushSoon(pageId) { this._historyFor(pageId)?.pushSoon(); },
  _historyPushNow(pageId) { this._historyFor(pageId)?.pushNow(); },

  // Verlauf einer Seite verwerfen — „Server-Fassung übernehmen" darf per Undo
  // nicht in die verworfene eigene Fassung zurückführen.
  _historyDrop(pageId) {
    this._histories?.get(pageId)?.clear();
    this._histories?.delete(pageId);
  },

  _historyDropAll() {
    if (this._histories) for (const h of this._histories.values()) h.clear();
    this._histories = new Map();
    this._histTick++;
  },

  // `_histTick` (hochgezählt über onChange des Kerns) macht die Abfrage
  // reaktiv: der Kern ist framework-frei und sein Stack für Alpine unsichtbar.
  bookEditorCanUndo() {
    void this._histTick;
    return this.activePageId != null && !!this._historyFor(this.activePageId)?.canUndo();
  },

  bookEditorCanRedo() {
    void this._histTick;
    return this.activePageId != null && !!this._historyFor(this.activePageId)?.canRedo();
  },

  bookEditorUndo() {
    if (this.activePageId == null) return;
    this._historyFor(this.activePageId)?.undo();
  },

  bookEditorRedo() {
    if (this.activePageId == null) return;
    this._historyFor(this.activePageId)?.redo();
  },

  // keydown am Block: true = konsumiert.
  _historyKeydown(event) {
    const cmd = matchHistoryCommand(event);
    if (!cmd) return false;
    event.preventDefault();
    if (cmd === 'undo') this.bookEditorUndo();
    else this.bookEditorRedo();
    return true;
  },

  // Natives Undo über andere Wege als die Tastatur.
  onBlockBeforeInput(event) {
    const t = event.inputType;
    if (t !== 'historyUndo' && t !== 'historyRedo') return;
    event.preventDefault();
    if (t === 'historyUndo') this.bookEditorUndo();
    else this.bookEditorRedo();
  },
};
