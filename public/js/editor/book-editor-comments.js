// Kommentar-Leiste des Bucheditors: verankerte Share-Link-Leser-Kommentare des
// GANZEN Buchs als Margin-Rail rechts neben dem Manuskript-Stream. Pendant zur
// Notebook-Read-Modus-Leiste (public/js/editor/comments-rail.js), aber scope =
// ganzer Stream statt einzelner Seite. Owner springt aus der „Geteilte Links"-
// Karte für Buch-/Kapitel-Shares hierher (Event `book-editor:goto-comment`).
//
// Verhalten (Laden, Re-Anchoring, Diff, Reply/Resolve/Delete, Goto-by-bid) kommt
// aus dem geteilten Kern public/js/editor/comment-rail-core.js (SSoT mit der
// Notebook-Leiste). Hier bleibt nur die Bucheditor-Glue: Scope =
// .book-editor-stream, eigene Highlight-Namen, Stream-Ready-Check, Window-Scroll.
// Methoden werden in bookEditorCard gespreadet; State-Felder sind dort deklariert.

import { createCommentRail } from './comment-rail-core.js';
import { createCommentLayout } from './comment-rail-layout.js';

function streamEl() { return document.querySelector('.book-editor-stream'); }
function layerEl() { return document.querySelector('.book-editor-comments__layer'); }

// Unter diesem Viewport die Leiste flach (statische Liste) rendern — die
// dritte Spalte stapelt sich dann unter den Stream (siehe book-editor.css).
const FLAT_BELOW = '(max-width: 800px)';

// Vertikale Verankerung (Google-Docs-Modell) aus dem geteilten Kern, Scope =
// ganzer Stream. State-Felder sind in bookEditorCard deklariert.
const layout = createCommentLayout({
  scopeEl: streamEl,
  layerEl,
  flatBelow: FLAT_BELOW,
  keys: { threads: 'commentThreads', selectedRootId: 'commentSelectedRootId', railVisible: 'commentRailVisible', stackHeight: 'commentStackHeight' },
});

const rail = createCommentRail({
  scopeEl: streamEl,
  hlAll: 'book-editor-comment-anchor',
  hlActive: 'book-editor-comment-anchor-active',
  keys: {
    comments: 'bookComments', threads: 'commentThreads', selectedRootId: 'commentSelectedRootId',
    railVisible: 'commentRailVisible', replyDrafts: 'commentReplyDrafts', savingReply: 'commentSavingReply',
    savingResolve: 'commentSavingResolve', loadingBookId: '_commentLoadingBookId',
    recomputeRaf: '_commentRecomputeRaf', pendingGotoBid: '_pendingGotoBid',
    generalThreads: 'commentGeneralThreads',
    filterStatus: 'commentFilterStatus', filterReviewer: 'commentFilterReviewer',
  },
  // Bucheditor = ganzes Buch: alle allgemeinen (nicht-verankerten) Kommentare jedes
  // Link-Scopes (Buch/Kapitel/Seite) gehören in diese Leiste.
  generalFilter: () => true,
  // Bucheditor ist immer „Stream-Modus" — kein Read/Edit-Guard.
  idle: () => false,
  // Recompute, sobald der Stream gerendert ist (Blocks via x-init/x-effect
  // imperativ gefüllt — kurz nach blocks-Set).
  shouldWait: (ctx) => !(streamEl() && ctx.blocks.length > 0),
  // Nach jedem Thread-Set die vertikale Verankerung neu berechnen (post-render,
  // weil Kartenhöhen gemessen werden müssen).
  afterRecompute: (ctx) => ctx._scheduleCommentLayout(),
  scrollToRange: (range) => {
    const r = range.getBoundingClientRect();
    if (r && r.height) window.scrollTo({ top: window.scrollY + r.top - 140, behavior: 'smooth' });
  },
  // Gegenrichtung (Klick im Text → Leiste): das passende Thread-Item in der
  // Leiste sichtbar scrollen. block:'nearest' scrollt den Leisten-Container, nicht
  // das Fenster. rAF, damit die Auswahl-DOM-Änderung (Foot aufgeklappt) gesetzt ist.
  scrollRailToThread: (rootId) => {
    requestAnimationFrame(() => {
      const sel = `.book-editor-comments .comment-rail__thread[data-root-id="${CSS.escape(String(rootId))}"]`;
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  },
});

export const bookEditorCommentsMethods = {
  ...rail,
  ...layout,

  // Partial-/Card-erwartete Methodennamen → geteilter Kern.
  _loadBookComments(bookId) { return this._railLoad(bookId); },
  _scheduleCommentRecompute() { return this._railSchedule(); },
  _recomputeCommentThreads() { return this._railRecompute(); },
  selectCommentThread(rootId) {
    this._railSelect(rootId);
    // Auswahl pinnt die aktive Karte auf ihre exakte Anker-Höhe und schiebt die
    // übrigen darum herum → Layout neu rechnen.
    this._scheduleCommentLayout();
  },
  replyToCommentRoot(thread) { return this._railReply(thread); },
  toggleCommentResolve(comment) { return this._railResolve(comment); },
  deleteBookComment(comment) { return this._railDelete(comment); },

  // Steht die Leiste? EINE Bedingung für die Leiste selbst und die dritte
  // Rasterspalte: ein Filter ohne Treffer zeigt die Leiste weiter (Filterknöpfe,
  // Leer-Hinweis) — ohne eigene Spalte rutschte sie in eine neue Rasterzeile
  // unter das ganze Manuskript.
  commentRailShown() {
    return this.commentRailVisible
      && !!(this.commentThreads.length || this.commentFilterStatus !== 'all' || this.commentFilterReviewer);
  },

  toggleCommentRail() {
    this.commentRailVisible = !this.commentRailVisible;
    // Highlights folgen der Sichtbarkeit: einblenden = neu lokalisieren+markieren,
    // ausblenden = Anker-Markierung im Stream entfernen.
    if (this.commentRailVisible) this._recomputeCommentThreads();
    else this._railClearHL();
  },

  // Klick in den Manuskript-Stream: liegt der Klick auf einer markierten
  // Kommentarstelle, den zugehörigen Thread in der Leiste anspringen. Nur wenn die
  // Kommentar-Leiste sichtbar ist (sonst existieren keine Highlights/Ranges).
  onStreamCommentClick(ev) {
    if (!this.commentRailVisible || !this.commentThreads.length) return;
    const rootId = this._railHitTest(ev.clientX, ev.clientY);
    if (rootId != null) this._railSelectFromText(rootId);
  },

  // Alias für die Card-Lifecycle/destroy (historischer Name).
  _clearCommentHL() { return this._railClearHL(); },

  // Vertikale Verankerung (_initCommentLayout/_scheduleCommentLayout/
  // _layoutCommentCards/_teardownCommentLayout) kommt aus dem geteilten
  // createCommentLayout-Bündel oben (...layout).
};
