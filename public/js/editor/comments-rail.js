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
import { scrollWindowToRange } from '../share-anchor.js';

const rail = createCommentRail({
  scopeEl: readView,
  hlAll: 'comment-rail-anchor',
  hlActive: 'comment-rail-anchor-active',
  keys: {
    comments: 'bookComments', threads: 'commentThreads', selectedRootId: 'commentSelectedRootId',
    railVisible: 'commentRailVisible', replyDrafts: 'commentReplyDrafts', savingReply: 'commentSavingReply',
    savingResolve: 'commentSavingResolve', loadingBookId: '_loadingBookId', recomputeRaf: '_recomputeRaf',
    pendingGotoToken: '_pendingGotoToken', generalThreads: 'commentGeneralThreads',
    filterStatus: 'commentFilterStatus', filterReviewer: 'commentFilterReviewer',
    totalCount: 'commentTotalCount', openCount: 'commentOpenCount',
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
  // Änderungsvorschlag: die Leiste zeigt nur Threads der offenen Seite, also
  // steht die Stelle in genau diesem Abschnitt. Danach die Leseansicht neu laden.
  suggestionTarget: () => {
    const p = window.__app?.currentPage;
    return p?.id ? { pageId: p.id, pageName: p.name } : null;
  },
  afterSuggestionApplied: async ({ pageId }) => {
    const app = window.__app;
    if (app?.currentPage?.id === pageId) await app._refetchCurrentPage?.();
  },
  // Klick im Text → Leiste: die Leiste ist ab 1100px ein eigener Scroll-Container
  // (max-height + overflow). Nur sie scrollen, nicht das Fenster — der User steht
  // schon an der Textstelle. Gestapelt (schmal) scrollt sie nicht → nichts tun.
  scrollRailToThread: (rootId) => {
    requestAnimationFrame(() => {
      const rail = document.querySelector('aside.comment-rail:not(.book-editor-comments)');
      const el = rail?.querySelector(`.comment-rail__thread[data-root-id="${CSS.escape(String(rootId))}"]`);
      if (!rail || !el || rail.scrollHeight <= rail.clientHeight + 1) return;
      const top = el.getBoundingClientRect().top - rail.getBoundingClientRect().top + rail.scrollTop;
      rail.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' });
    });
  },
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
  decideCommentSuggestion(thread, decision) { return this._railDecideSuggestion(thread, decision); },

  init() {
    this._railAbort = new AbortController();
    // Buchwechsel: State leeren + Kommentare des neuen Buchs laden.
    this.$watch(() => Alpine.store('nav').selectedBookId, (id) => this._onBookChange(id));
    // Seitenwechsel: Leiste einklappen und Triage-Filter zurücksetzen (beides ist
    // pro Seite — sonst „folgt" der Zustand unsichtbar auf die nächste Seite) +
    // neu auflösen. Edit↔Read / frisch gerendertes Seiten-HTML nur neu auflösen.
    this.$watch(() => window.__app?.currentPage?.id, () => {
      this.commentRailVisible = false;
      this._railResetFilter();
      this.scheduleRecompute();
    });
    this.$watch(() => window.__app?.editMode, () => this.scheduleRecompute());
    this.$watch(() => window.__app?.checkDone, () => this.scheduleRecompute());
    this.$watch(() => window.__app?.renderedPageHtml, () => this.scheduleRecompute());
    window.addEventListener(EVT.VIEW_RESET, () => this._onBookChange(null), { signal: this._railAbort.signal });
    // Kommentare live: die Collab-Schicht meldet geänderte Share-Link-Kommentare
    // des Buchs (app/app-collab-stream.js#_onShareCommentsChanged).
    window.addEventListener(EVT.SHARE_COMMENTS_CHANGED, () => {
      const id = Alpine.store('nav').selectedBookId;
      if (id) this.loadBookComments(id);
    }, { signal: this._railAbort.signal });
    // Toggle-Button in den Seiten-Actions (Root-Scope) steuert die Sichtbarkeit
    // per Window-Event (Trampolin, da der Button nicht im Karten-Scope liegt).
    window.addEventListener(EVT.COMMENTS_RAIL_TOGGLE, () => this.toggleRail(), { signal: this._railAbort.signal });
    // Klick auf eine markierte Stelle im Seitentext wählt ihren Thread (Pendant
    // zum Bucheditor); jeder andere Klick ausserhalb des offenen Threads schliesst ihn.
    document.addEventListener('click', (e) => {
      this.onTextCommentClick(e);
      this._railDeselectOutside(e);
    }, { signal: this._railAbort.signal });
    // Sprung aus der „Geteilte Links"-Karte (Seiten-Share): Leiste öffnen + ersten
    // offenen Thread dieses Links selektieren (Pendant zum Bucheditor-Sprung).
    window.addEventListener(EVT.COMMENTS_RAIL_GOTO, (e) => {
      this.commentRailVisible = true;
      this._railResetFilter();
      this._pendingGotoToken = e.detail?.token || null;
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
    if (app) { app.pageCommentRailOpen = false; app.pageCommentCount = 0; app.pageCommentTotal = 0; }
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
    this.commentTotalCount = 0;
    this.commentOpenCount = 0;
    this._railResetFilter();
    this._pendingGotoToken = null;
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
    scrollWindowToRange(range, 140);
  },

  // Klick im Seitentext: liegt er auf einer markierten Kommentarstelle, deren
  // Thread wählen und die Leiste hinscrollen. Nur bei sichtbarer Leiste (sonst
  // gibt es keine Markierungen) und nur innerhalb der Leseansicht.
  onTextCommentClick(ev) {
    if (!this.commentRailVisible || !this.commentThreads.length) return;
    const view = readView();
    if (!view || !view.contains(ev.target)) return;
    const rootId = this._railHitTest(ev.clientX, ev.clientY);
    if (rootId != null && rootId !== this.commentSelectedRootId) this._railSelectFromText(rootId);
  },

  // Ausblend-Verlauf an der Unterkante der Leiste, solange darunter noch Karten
  // liegen (eigener Scroll-Container ab 1100px). Aufruf aus @scroll, aus x-resize
  // der Kartenliste und nach jedem Spiegeln (Leiste auf/zu, Seitenwechsel).
  updateRailScrollHint(el) {
    const rail = el || document.querySelector('aside.comment-rail:not(.book-editor-comments)');
    if (!rail) return;
    const more = rail.scrollHeight - rail.clientHeight - rail.scrollTop > 4;
    rail.classList.toggle('has-more-below', more);
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
    // Ungefiltert zählen (verankerte + allgemeine des Page-Shares dieser Seite):
    // Knopf sichtbar, sobald die Seite Threads hat; Badge = offene. Ein Filter ohne
    // Treffer nimmt so weder den Knopf noch die Rasterspalte weg.
    const reading = !app.editMode && !app.checkDone;
    const total = reading ? (this.commentTotalCount || 0) : 0;
    app.pageCommentTotal = total;
    app.pageCommentCount = reading ? (this.commentOpenCount || 0) : 0;
    app.pageCommentRailOpen = !!(this.commentRailVisible && total);
    requestAnimationFrame(() => this.updateRailScrollHint());
  },
};
