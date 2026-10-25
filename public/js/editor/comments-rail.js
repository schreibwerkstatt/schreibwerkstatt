// Kommentar-Leiste der Leseansicht (Notebook-Editor, Read-Modus). Zeigt
// verankerte Share-Link-Leser-Kommentare als Margin-Rail rechts neben dem
// Seitentext (Google-Docs-Stil): selektieren hebt die Textstelle hervor,
// antworten/erledigt/löschen laufen über die bestehenden Owner-Endpoints in
// routes/share.js. Allgemeine (nicht-verankerte) Kommentare des Page-Shares
// genau dieser Seite zeigt diese Leiste in einem abgesetzten Abschnitt mit
// (generalFilter); Buch-/Kapitel-Share-Allgemeines lebt im Bucheditor.
//
// Verhalten (Laden, Re-Anchoring, Diff, Reply/Resolve/Delete) kommt aus dem
// geteilten Kern public/js/editor/comment-rail-core.js (SSoT mit der Bucheditor-
// Leiste). Hier bleibt nur die Notebook-spezifische Glue: Scope =
// .page-view-wrap, Read-Modus-Guard, Root-Flag-Mirror (Grid-Split + Toggle-Badge)
// und der Scroll-zur-Stelle.
//
// Anders als der Bucheditor schweben die Karten hier NICHT auf Höhe ihrer
// Textstelle (Google-Docs-Modell): das Blatt der Leseansicht (.page-content-view)
// ist ein eigener Scroll-Container (max-height + overflow), kein Fenster-Scroll —
// vertikale Verankerung gegen einen fremden Scroll-Container desynchronisiert. Die
// Karten stapeln stattdessen normal in einer eigenen Spalte; Auswahl scrollt das
// Blatt zur verankerten Stelle (comment-rail-layout.js wird hier nicht genutzt).

import { createCommentRail } from './comment-rail-core.js';
import { EVT } from '../events.js';
import { notebookReadView as readView } from './notebook/read-view.js';

const rail = createCommentRail({
  scopeEl: readView,
  hlAll: 'comment-rail-anchor',
  hlActive: 'comment-rail-anchor-active',
  keys: {
    comments: 'bookComments', threads: 'commentThreads', selectedRootId: 'commentSelectedRootId',
    railVisible: 'commentRailVisible', replyDrafts: 'commentReplyDrafts', savingReply: 'commentSavingReply',
    savingResolve: 'commentSavingResolve', loadingBookId: '_loadingBookId', recomputeRaf: '_recomputeRaf',
    pendingGotoBid: '_pendingGotoBid', generalThreads: 'commentGeneralThreads',
    filterStatus: 'commentFilterStatus', filterReviewer: 'commentFilterReviewer',
  },
  // Allgemeine (nicht-verankerte) Kommentare gehören in diese Seitenleiste, wenn der
  // Link ein Page-Share genau der offenen Seite ist — Buch-/Kapitel-Share-Allgemeines
  // hat keine eindeutige Seite und lebt im Bucheditor.
  generalFilter: (root, app) =>
    root.link_kind === 'page' && String(root.link_page_id) === String(app?.currentPage?.id ?? ''),
  // Rail nur im Read-Modus (kein Edit, kein Lektorat-Split). Kein App-Root → idle.
  idle: (app) => !app || app.editMode || app.checkDone,
  // Recompute verschieben, bis die Read-View gerendert ist (.page-content-view
  // wird erst nach x-html befüllt). Im Idle-Zustand nicht warten — recompute
  // räumt dann auf.
  shouldWait: (ctx, app) => {
    const idle = !app || app.editMode || app.checkDone || !app.currentPage;
    const rendered = !!(readView() && app?.renderedPageHtml);
    return !idle && !rendered;
  },
  // Nach jedem Thread-Set: Root-Flag spiegeln (Grid-Split + Badge).
  afterRecompute: (ctx) => { ctx._mirrorFlag(); },
  scrollToRange: (range, ctx) => ctx._scrollRangeIntoView(range),
});

export const editorCommentsRailMethods = {
  ...rail,

  // Partial-erwartete Methodennamen → geteilter Kern. Die im geteilten Body-
  // Fragment (comment-thread-body.html) referenzierten Namen sind mit dem
  // Bucheditor vereinheitlicht (comment*-Präfix).
  loadBookComments(bookId) { return this._railLoad(bookId); },
  scheduleRecompute() { return this._railSchedule(); },
  recomputePageThreads() { return this._railRecompute(); },
  selectCommentThread(rootId) {
    // Auswahl hebt die Stelle hervor und scrollt das Blatt dorthin (kein
    // Karten-Layout — die Karten stehen in normaler Stapelreihenfolge).
    this._railSelect(rootId);
  },
  replyToCommentRoot(thread) { return this._railReply(thread); },
  toggleCommentResolve(comment) { return this._railResolve(comment); },
  deleteBookComment(comment) { return this._railDelete(comment); },

  init() {
    this._railAbort = new AbortController();
    // Buchwechsel: State leeren + Kommentare des neuen Buchs laden.
    this.$watch(() => Alpine.store('nav').selectedBookId, (id) => this._onBookChange(id));
    // Seitenwechsel: Leiste einklappen (Toggle ist pro Seite — sonst „folgt" der
    // offene Zustand auf die nächste Seite, die zufällig Kommentare hat) + neu
    // auflösen. Edit↔Read / frisch gerendertes Seiten-HTML nur neu auflösen.
    this.$watch(() => window.__app?.currentPage?.id, () => { this.commentRailVisible = false; this.scheduleRecompute(); });
    this.$watch(() => window.__app?.editMode, () => this.scheduleRecompute());
    this.$watch(() => window.__app?.checkDone, () => this.scheduleRecompute());
    this.$watch(() => window.__app?.renderedPageHtml, () => this.scheduleRecompute());
    window.addEventListener(EVT.VIEW_RESET, () => this._onBookChange(null), { signal: this._railAbort.signal });
    // Toggle-Button in den Seiten-Actions (Root-Scope) steuert die Sichtbarkeit
    // per Window-Event (Trampolin, da der Button nicht im Karten-Scope liegt).
    window.addEventListener(EVT.COMMENTS_RAIL_TOGGLE, () => this.toggleRail(), { signal: this._railAbort.signal });
    // Klick ausserhalb des offenen Threads (Seitentext, Chrome) schliesst ihn wieder.
    document.addEventListener('click', (e) => this._railDeselectOutside(e), { signal: this._railAbort.signal });
    // Sprung aus der „Geteilte Links"-Karte (Seiten-Share): Leiste öffnen + Thread
    // zu diesem data-bid selektieren (Pendant zum Bucheditor-Sprung).
    window.addEventListener(EVT.COMMENTS_RAIL_GOTO, (e) => {
      this.commentRailVisible = true;
      this._pendingGotoBid = e.detail?.bid || null;
      this.scheduleRecompute();
    }, { signal: this._railAbort.signal });
    // Initial laden, falls schon ein Buch offen ist.
    const id = Alpine.store('nav').selectedBookId;
    if (id) this._onBookChange(id);
  },

  destroy() {
    this._railAbort?.abort();
    this._railCancelSchedule();
    this._railClearHL();
    const app = window.__app;
    if (app) { app.pageCommentRailOpen = false; app.pageCommentCount = 0; }
  },

  async _onBookChange(bookId) {
    // Laufenden Load + Recompute des alten Buchs entwerten — auch bei
    // view:reset (bookId null), wo kein neuer Load die ID überschreibt.
    this._railInvalidateLoad();
    this._railCancelSchedule();
    this.bookComments = [];
    this.commentThreads = [];
    this.commentGeneralThreads = [];
    this.commentSelectedRootId = null;
    this.commentRailVisible = false;
    this._pendingGotoBid = null;
    this._railClearHL();
    this._mirrorFlag();
    if (!bookId) return;
    await this.loadBookComments(bookId);
  },

  // Auswahl scrollt zur verankerten Stelle. Der eigentliche Scroll-Container ist
  // das Blatt selbst (.page-content-view: max-height + overflow-y) — nicht das
  // Fenster. Die Range liegt darin; relativ zur Blatt-Oberkante scrollen, damit
  // die Stelle sichtbar wird. Nur falls das Blatt (noch) nicht scrollt (kurze
  // Seite), aufs Fenster zurückfallen.
  _scrollRangeIntoView(range) {
    const r = range.getBoundingClientRect();
    if (!r || !r.height) return;
    const pane = readView();
    if (pane && pane.scrollHeight > pane.clientHeight + 1) {
      const paneRect = pane.getBoundingClientRect();
      pane.scrollTo({ top: pane.scrollTop + (r.top - paneRect.top) - 80, behavior: 'smooth' });
      return;
    }
    window.scrollTo({ top: window.scrollY + r.top - 140, behavior: 'smooth' });
  },

  collapseRail() { this.commentRailVisible = false; this._railClearHL(); this._mirrorFlag(); },
  toggleRail() {
    this.commentRailVisible = !this.commentRailVisible;
    // Highlights folgen der Sichtbarkeit: einblenden = neu lokalisieren+markieren,
    // ausblenden = Anker-Markierung im Seitentext entfernen.
    if (this.commentRailVisible) this.recomputePageThreads();
    else { this._railClearHL(); this._mirrorFlag(); }
  },

  // Root-Flag spiegeln: steuert die Grid-Klasse `comments-split` an
  // .editor-body-wrap (analog checkDone → lektorat-split). Zusätzlich die
  // verankerte Thread-Anzahl spiegeln (Badge + Sichtbarkeit des Toggle-Buttons
  // in den Seiten-Actions). window.__app ist der reaktive Alpine-Proxy.
  _mirrorFlag() {
    const app = window.__app;
    if (!app) return;
    // Verankerte + allgemeine (Page-Share dieser Seite) Threads zählen.
    const onPage = !app.editMode && !app.checkDone
      ? this.commentThreads.length + (this.commentGeneralThreads?.length || 0) : 0;
    app.pageCommentCount = onPage;
    app.pageCommentRailOpen = !!(this.commentRailVisible && onPage);
  },
};
