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
import { scrollWindowToRange } from '../share-anchor.js';

function streamEl() { return document.querySelector('.book-editor-stream'); }
function layerEl() { return document.querySelector('.book-editor-comments__layer'); }

function layoutEl() { return document.querySelector('.card--bookeditor .book-editor-layout'); }

// Unter diesem Viewport stapelt das ganze Layout einspaltig (book-editor.css,
// Mobile-Block) — die Leiste ist dann immer flach.
const MOBILE_BELOW = '(max-width: 800px)';
// Schmalste Textspalte, die neben der Leiste noch lesbar ist (px). Darunter weicht
// erst das Inhaltsverzeichnis, dann rückt die Leiste flach unter den Stream.
const STREAM_MIN = 480;

// Spaltenbreiten wie in book-editor.css (grid-template-columns von
// .book-editor-layout--comments, normal bzw. :fullscreen). Gemessen wird nicht,
// weil die Spalten im gesuchten Modus noch gar nicht existieren.
function columnWidths() {
  const vw = window.innerWidth || 0;
  const fs = !!document.fullscreenElement?.classList?.contains('card--bookeditor');
  return fs
    ? { outline: 360, rail: Math.min(460, Math.max(320, vw * 0.26)) }
    : { outline: 280, rail: Math.min(340, Math.max(280, vw * 0.22)) };
}

// Platz-Modus der Kommentar-Leiste im Editor-Pane (die Pane-Breite zählt, nicht
// der Viewport): 'full' = Outline | Stream | Leiste, 'no-outline' = Outline weicht
// (solange die Leiste offen ist), 'flat' = Leiste als Liste unter dem Stream.
// Hat der User die Outline trotz Platzmangel wieder eingeblendet
// (_outlineForced), rückt stattdessen die Leiste unter den Text.
function paneMode(ctx) {
  if (!ctx.commentRailShown()) return 'full';
  if (window.matchMedia?.(MOBILE_BELOW).matches) return 'flat';
  const el = layoutEl();
  if (!el) return ctx.commentPaneMode || 'full';
  const W = el.clientWidth;
  const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
  const { outline, rail } = columnWidths();
  if (rail + gap + STREAM_MIN > W) return 'flat';
  if (!ctx.outlineOpen || outline + rail + 2 * gap + STREAM_MIN <= W) return 'full';
  return ctx._outlineForced ? 'flat' : 'no-outline';
}

// Vertikale Verankerung (Google-Docs-Modell) aus dem geteilten Kern, Scope =
// ganzer Stream. State-Felder sind in bookEditorCard deklariert.
const layout = createCommentLayout({
  scopeEl: streamEl,
  layerEl,
  // Platz-Modus vor jedem Layout-Pass nachführen (Resize, Stream-Reflow, Toggle).
  beforeLayout: (ctx) => ctx._updateCommentPaneMode(),
  isFlat: (ctx) => ctx.commentPaneMode === 'flat',
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
    recomputeRaf: '_commentRecomputeRaf', pendingGotoToken: '_pendingGotoToken',
    generalThreads: 'commentGeneralThreads',
    filterStatus: 'commentFilterStatus', filterReviewer: 'commentFilterReviewer',
    totalCount: 'commentTotalCount', openCount: 'commentOpenCount',
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
  scrollToRange: (range) => scrollWindowToRange(range, 140),
  // Änderungsvorschlag: der Abschnitt, dessen Block die verankerte Stelle trägt.
  // Ungespeicherte Änderungen dort (oder ein offener Konflikt) → warten, statt
  // sie mit dem Server-Stand zu überschreiben.
  suggestionTarget: (thread, ctx) => {
    const needle = `data-bid="${String(thread.root.anchor_bid || '')}"`;
    const block = (ctx.blocks || []).find(b => b.kind === 'page' && String(b.html || '').includes(needle));
    if (!block) return null;
    if (block.dirty || block.saving || block.conflict) return { busy: true };
    return { pageId: block.pageId, pageName: block.name || block.pageName || '' };
  },
  // Neuen Stand in den Block schreiben — dasselbe Muster wie „Fremde Fassung
  // übernehmen" (book-editor/save.js#resolveConflictTakeRemote): ein aktiver
  // Block wird erst deaktiviert, sonst liesse `_maybeRehydrate` sein DOM stehen;
  // der Undo-Verlauf fällt, sonst holte Cmd+Z den Stand vor dem Vorschlag zurück
  // und speicherte ihn über die Übernahme.
  // Hat der User während Laden/Speichern im Block getippt, bleibt seine Eingabe
  // stehen: sein nächster Save trifft auf den neueren Server-Stand und landet im
  // Konflikt-Dialog, statt still überschrieben zu werden.
  afterSuggestionApplied: ({ pageId, html, saved }, ctx) => {
    const block = ctx._blockById?.(pageId);
    if (!block || block.dirty || block.saving || block.conflict) return;
    ctx._historyDrop?.(pageId);
    block.html = html;
    block.originalHtml = html;
    if (saved?.updated_at) block.originalUpdatedAt = saved.updated_at;
    block.dirty = false;
    ctx._writeBlockDraft?.(block);
    if (ctx.activePageId === pageId) ctx.activePageId = null;
    block._rev++;
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
  decideCommentSuggestion(thread, decision) { return this._railDecideSuggestion(thread, decision); },

  // Steht die Leiste? EINE Bedingung für die Leiste selbst und ihre Rasterspalte:
  // sobald das Buch Threads hat (ungefiltert) — ein Filter ohne Treffer zeigt die
  // Leiste weiter (Filterknöpfe, Leer-Hinweis); ohne eigene Spalte rutschte sie in
  // eine neue Rasterzeile unter das ganze Manuskript.
  commentRailShown() {
    return this.commentRailVisible
      && !!(this.commentTotalCount || this.commentFilterStatus !== 'all' || this.commentFilterReviewer);
  },

  // Platz-Modus neu bestimmen; nur bei Wechsel schreiben (reaktiver State).
  _updateCommentPaneMode() {
    const mode = paneMode(this);
    if (mode !== this.commentPaneMode) this.commentPaneMode = mode;
  },

  // Outline wirklich sichtbar? Die Präferenz `outlineOpen` bleibt unangetastet;
  // im Modus 'no-outline' weicht die Outline nur, solange die Leiste offen ist.
  outlineShown() {
    return this.outlineOpen && !(this.commentRailShown() && this.commentPaneMode === 'no-outline');
  },

  // Outline-Knopf: weicht die Outline gerade der Leiste, holt ein Klick sie zurück
  // und schickt die Leiste unter den Text; sonst normales Umschalten.
  onOutlineButton() {
    if (this.outlineOpen && !this.outlineShown()) {
      this._outlineForced = true;
    } else {
      this.outlineOpen = !this.outlineOpen;
      this._outlineForced = false;
    }
    this._updateCommentPaneMode();
    this._scheduleCommentLayout();
  },

  toggleCommentRail() {
    this.commentRailVisible = !this.commentRailVisible;
    // Highlights folgen der Sichtbarkeit: einblenden = neu lokalisieren+markieren,
    // ausblenden = Anker-Markierung im Stream entfernen.
    if (this.commentRailVisible) {
      this._recomputeCommentThreads();
      // Modus sofort setzen, nicht erst im Layout-Pass — sonst steht für einen
      // Frame das zu enge Dreispalten-Raster.
      this._updateCommentPaneMode();
    } else {
      this._railClearHL();
      this._outlineForced = false;
      this.commentPaneMode = 'full';
    }
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
