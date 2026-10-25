// Alpine.data('bookEditorCard') — Bucheditor (Facade).
//
// Rendert alle Kapitel + Seiten eines Buchs in Lesereihenfolge als Sequenz
// separater contenteditable-Blöcke. Hier liegen State, Lifecycle, Laden und
// die Block-Interaktion; die Fachteile in cards/book-editor/:
//   save.js    — Save-Queue, Konflikte, Status-Ableitung
//   find.js    — Find/Replace über den ganzen Stream
//   outline.js — Inhaltsverzeichnis + IntersectionObserver
//   history.js — Undo/Redo pro Seite (eigener Verlauf statt Browser-Stack)
//   head.js    — Titel-Kopf je Beitrag (publizistische Bücher)
//   blocks.js  — Blockliste, ohne Netz aus dem Content-Cache
//   drafts.js  — lokale Entwürfe, Live-Markierung, Online-Retry
//   activation.js — Render-Sync der Blöcke, Klick-aktiviert-Block
// Kommentar-Leiste: editor/book-editor-comments.js.
//
// Click-aktiviert-Block: Default contenteditable=false; Klick setzt aktive
// pageId, Caret aus Mousedown-Position. Verlassen flusht Save bei dirty.

import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync, toggleWrapFullscreen } from '../fullscreen.js';
import { bookEditorCommentsMethods } from '../editor/book-editor-comments.js';
import { bookEditorFindMethods, clearHighlights } from './book-editor/find.js';
import { bookEditorOutlineMethods, buildOutlineNodes } from './book-editor/outline.js';
import { bookEditorSaveMethods } from './book-editor/save.js';
import { bookEditorConflictMethods } from './book-editor/conflict.js';
import { bookEditorHistoryMethods } from './book-editor/history.js';
import { bookEditorHeadMethods } from './book-editor/head.js';
import { bookEditorDraftMethods } from './book-editor/drafts.js';
import { bookEditorActivationMethods } from './book-editor/activation.js';
import { buildBlocksFromPages, fetchBookContents } from './book-editor/blocks.js';
import { draftsLoaded } from '../editor/draft-storage.js';
import { createAutosaveTimers } from '../editor/shared/autosave.js';
import { createTimerBag } from '../editor/shared/timers.js';
import { EVT } from '../events.js';
import { tErrorRaw } from '../i18n.js';
import { registerBusySource } from '../app/boot/update-policy.js';
import { memoMethods } from './card-memo.js';

// Re-Export für Tests/Konsumenten: die Facade ist der Einstieg.
export { applySaveOutcome } from './book-editor/save.js';
export { buildBlocksFromPages };

// Zustand, der an ein Buch bzw. eine Ansicht gebunden ist. EINE Deklaration für
// Initial-State und `resetState` des Lifecycles — zwei Listen driften sonst
// auseinander (neues Feld im Init vergessen → überlebt den Buchwechsel).
// Bewusst NICHT dabei: Präferenzen, die über den Buchwechsel hinaus gelten
// (outlineOpen, findCaseSensitive/-WholeWord, bookEditorFullscreen).
const sessionState = () => ({
  blocks: [],
  loading: false,
  loadError: '',
  offlineSource: false,   // Stream aus dem Content-Cache (kein Netz), drafts.js
  activePageId: null,
  saveQueue: [],
  conflictResolution: null, // Auflösungs-Modal (book-editor/conflict.js)
  saveAllRunning: false,
  // Pages, die der laufende Save-All-Durchgang abarbeitet — Quelle für die
  // Fortschrittsanzeige (siehe saveAllTotal/saveAllDone).
  saveAllIds: [],

  findOpen: false,
  findTerm: '',
  findReplace: '',
  findMatches: [],
  findIndex: -1,

  // Outline (Inhaltsverzeichnis): aktuell sichtbarer Page-Block via
  // IntersectionObserver. collapsedChapters: Set<chapterId> für eingeklappte
  // Kapitel-Gruppen.
  visiblePageId: null,
  collapsedChapters: {},

  // Kommentar-Leiste (verankerte Leser-Kommentare des ganzen Buchs) —
  // Methoden in editor/book-editor-comments.js.
  bookComments: [],
  commentThreads: [],
  commentGeneralThreads: [],
  commentSelectedRootId: null,
  commentReplyDrafts: {},
  commentSavingReply: null,
  commentSavingResolve: null,
  commentRailVisible: false,
  // Triage-Filter: 'all' | 'open' | 'resolved' + Reviewer-Name ('' = alle).
  commentFilterStatus: 'all',
  commentFilterReviewer: '',
  commentStackHeight: 0,   // Höhe des verankerten Karten-Stapels (px), treibt --comments-stack-height
  _pendingGotoBid: null,
  heads: {},   // page_id → { dachzeile, titel, lead } (book-editor/head.js)

  _memos: {},
});

export function registerBookEditorCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookEditorCard', () => ({
    ...sessionState(),

    // Persistente Präferenzen (überleben Buch-/View-Wechsel).
    outlineOpen: true,
    findCaseSensitive: false,
    findWholeWord: false,
    // Native-Fullscreen-Status (gespiegelt vom fullscreenchange-Listener) — mehr
    // Platz für den Manuskript-Stream. Toggle in toggleBookEditorFullscreen.
    bookEditorFullscreen: false,

    // Interna ohne Reset-Bedarf: Timer-/Observer-Handles, Re-Entry-Guards.
    _autosave: null,          // createAutosaveTimers, Key = pageId
    _savedFlash: null,        // createTimerBag, nullt savedAt nach SAVED_FLASH_MS
    _queueRun: null,          // Promise des laufenden Queue-Durchlaufs
    _loadToken: 0,            // Re-Entry-Guard gegen überholende _load-Responses
    _pendingMousedown: null,
    _findRecomputeTimer: null,
    _findAnchor: null,        // Caret beim Öffnen der Suche (book-editor/find.js)
    _switching: false,        // Buch-/Ansichtswechsel läuft (_resetSession) — kein Bearbeiten
    _outlineObserver: null,
    _diagramObserver: null,   // Diagramme erst nahe dem Sichtbereich rendern (activation.js)
    _commentLoadingBookId: null,
    _commentRecomputeRaf: null,
    _commentLayoutRaf: null,
    _commentResizeObs: null,
    _commentObserved: null,
    _commentResizeHandler: null,
    _lifecycle: null,
    // Undo/Redo-Verläufe pro Seite + Hilfsfelder: cards/book-editor/history.js.
    _histories: null,
    _histTick: 0,
    _histCaptureEl: null,
    _histCapturePageId: null,

    init() {
      this._autosave = createAutosaveTimers((pageId) => this._enqueueSave(pageId));
      this._savedFlash = createTimerBag();

      this._lifecycle = setupCardLifecycle(this, {
        name: 'bookEditor',
        showFlag: 'showBookEditorCard',
        timerKeys: [],
        load: () => this._load(Alpine.store('nav').selectedBookId),
        // Eigene Reset-Pfade statt `resetState`: ein sofortiges `blocks = []`
        // verwürfe ungespeicherte Blöcke im Autosave-Fenster (siehe
        // _resetSession).
        onBookChanged: () => this._resetSession({ reload: true }),
        onViewReset: () => this._resetSession({ reload: false }),
      });

      // Vertikale Verankerung der Kommentar-Karten: Observer für Stream-Reflow +
      // Viewport-Resize (Re-Layout). Methoden in editor/book-editor-comments.js.
      this._initCommentLayout();
      this._initDrafts(this._lifecycle.signal);

      window.addEventListener('beforeunload', (e) => {
        if (this.dirtyCount > 0 || this.savingCount > 0) {
          e.preventDefault();
          e.returnValue = '';
        }
      }, { signal: this._lifecycle.signal });
      // Gleiche Aussage für die Update-Politik: kein Generationswechsel über
      // ungespeicherte Blöcke hinweg (app/boot/update-policy.js#isBusy).
      const unregisterBusy = registerBusySource(() => this.dirtyCount > 0 || this.savingCount > 0);
      this._lifecycle.signal.addEventListener('abort', unregisterBusy, { once: true });

      // Karte zu: Ungespeichertes jetzt speichern, nicht erst nach dem Autosave-
      // Fenster — der User hat den Bucheditor verlassen.
      this.$watch(() => window.__app?.showBookEditorCard, (shown) => {
        if (!shown) this._saveDirtyNow();
      });

      // Cmd/Ctrl+F-Routing via editor-find-card: dispatcht hierher, wenn die
      // Karte sichtbar ist.
      window.addEventListener(EVT.BOOK_EDITOR_OPEN_FIND, () => {
        if (window.__app?.showBookEditorCard) this.openFind();
      }, { signal: this._lifecycle.signal });

      // Sprung aus der „Geteilte Links"-Karte (Buch-/Kapitel-Share): zur
      // kommentierten Stelle im Stream + Thread in der Leiste öffnen.
      window.addEventListener(EVT.BOOK_EDITOR_GOTO_COMMENT, (e) => {
        this.commentRailVisible = true;
        this._pendingGotoBid = e.detail?.bid || null;
        if (this.blocks.length) this._scheduleCommentRecompute();
      }, { signal: this._lifecycle.signal });

      // Klick ausserhalb des offenen Threads (Manuskript-Stream, Chrome) schliesst
      // ihn wieder; Klicks in der Leiste oder auf eine markierte Stelle bleiben aktiv.
      document.addEventListener('click', (e) => this._railDeselectOutside(e), { signal: this._lifecycle.signal });

      // Native Fullscreen-API: Status spiegeln (Toggle-Button + Esc-Exit).
      // $root = die Karten-Wurzel (.card--bookeditor), unabhängig vom Klick-Kontext.
      attachFullscreenSync({
        resolveWrap: () => this.$root,
        signal: this._lifecycle.signal,
        onChange: (active) => { this.bookEditorFullscreen = active; },
      });
    },

    destroy() {
      this._autosave?.clearAll();
      this._savedFlash?.clearAll();
      if (this._findRecomputeTimer) { clearTimeout(this._findRecomputeTimer); this._findRecomputeTimer = null; }
      this._teardownOutlineObserver();
      this._teardownDiagramObserver();
      this._railCancelSchedule();
      this._teardownCommentLayout();
      this._clearCommentHL();
      clearHighlights();
      this._historyDropAll();
      this._lifecycle?.destroy();
    },

    // ── Buch-/Ansichtswechsel ──────────────────────────────────────────────
    // `book:changed` / `view:reset`: erst die ungespeicherten Blöcke des alten
    // Buchs speichern, DANN den Session-State verwerfen. Die Save-Queue arbeitet
    // auf den Block-Objekten; ein vorgezogenes `blocks = []` liesse
    // `_blockById` null liefern und die Änderungen im Autosave-Fenster gingen
    // still verloren. Gesichert wird über den Snapshot der Block-Objekte, nicht
    // über `saveQueue`-IDs — ein paralleles `_load` darf `blocks` inzwischen
    // ersetzt haben.
    async _resetSession({ reload }) {
      const token = ++this._loadToken;   // überholt ein laufendes _load
      // Während des Sicherns nicht weiter bearbeiten: der Stream zeigt noch das
      // alte Buch, und was jetzt getippt würde, fehlte in der Bilanz unten.
      this._switching = true;
      this._deactivateBlock();
      let lost;
      try {
        lost = await this._settleBlocks();
      } finally {
        if (token === this._loadToken) this._switching = false;
      }
      // Ungespeichert, aber als Entwurf gesichert: die Outbox sendet nach.
      const unsafe = lost.filter(b => b.draftFailed).length;
      if (lost.length > 0) {
        const app = window.__app;
        app?.setStatus?.(unsafe ? app.t('bookEditor.unsavedOnSwitch', { n: unsafe }) : app.t('bookEditor.keptAsDraft', { n: lost.length }), !!unsafe, 8000);
      }
      // Neuerer Wechsel während des Speicherns: der räumt selbst ab.
      if (token !== this._loadToken) return;
      this._autosave.clearAll();
      this._savedFlash.clearAll();
      if (this._findRecomputeTimer) { clearTimeout(this._findRecomputeTimer); this._findRecomputeTimer = null; }
      this._teardownOutlineObserver();
      this._teardownDiagramObserver();
      clearHighlights();
      this._clearCommentHL();
      this._railCancelSchedule();
      this._railInvalidateLoad();
      this._historyDropAll();
      Object.assign(this, sessionState());
      if (!reload) return;
      if (!window.__app?.showBookEditorCard) return;
      const bookId = Alpine.store('nav').selectedBookId;
      if (bookId) await this._load(bookId);
    },

    // Ungespeicherte/laufende Blöcke zu Ende bringen, bevor `blocks` ersetzt
    // wird: ausstehende Entwürfe schreiben, laufenden Save abwarten, Dirty
    // speichern. Liefert die Blöcke, die dirty geblieben sind (als Entwurf
    // gesichert, die Outbox sendet nach). Gemeinsam für Buch-/Ansichtswechsel
    // und Neuladen (Re-Klick auf die offene Karte).
    async _settleBlocks() {
      this._autosave.clearAll();
      this._flushBlockDrafts();
      const pending = this.blocks.filter(b => b.kind === 'page' && (b.dirty || b.saving));
      if (!pending.length) return [];
      if (this._queueRun) { try { await this._queueRun; } catch { /* Fehler steht am Block */ } }
      for (const b of pending) {
        if (b.dirty && !b.saving && !b.conflict) await this._saveBlock(b);
      }
      return pending.filter(b => b.dirty);
    },

    // ── Laden ──────────────────────────────────────────────────────────────
    async _load(bookId) {
      if (!bookId) return;
      // Buchwechsel und showFlag-Watch können beide laden; ohne Token gewinnt
      // die langsamere Response und schreibt das alte Buch in die Karte.
      const token = ++this._loadToken;
      // Neuladen über laufender Arbeit (Re-Klick, `card:refresh`): erst sichern.
      // Sonst liefe ein Save auf verwaisten Block-Objekten weiter, und ein
      // ausstehender Entwurf landete nach dem Neuaufbau.
      if (this.blocks.some(b => b.kind === 'page' && (b.dirty || b.saving))) {
        await this._settleBlocks();
        if (token !== this._loadToken) return;
      }
      this._autosave.clearAll();
      this._savedFlash.clearAll();
      this.loading = true;
      this.loadError = '';
      this.blocks = [];
      this.activePageId = null;
      this._historyDropAll();
      this._teardownDiagramObserver();
      this._memos = {};
      // Treffer zeigen auf die alten Block-Knoten — nach dem Neuaufbau neu suchen.
      this.findMatches = [];
      this.findIndex = -1;
      this._findAnchor = null;
      clearHighlights();
      try {
        const data = await fetchBookContents(bookId);
        if (token !== this._loadToken) return;
        this.blocks = buildBlocksFromPages(data.pages || []);
        this.offlineSource = !!data.offline;
        this.loading = false;
        this._restoreBlockDrafts();   // wartet nicht: Entwürfe stehen seit dem Start im Spiegel …
        // … ausser IndexedDB war langsamer als der Start-Deckel: dann nachziehen.
        draftsLoaded().then(() => { if (token === this._loadToken) this._restoreBlockDrafts({ late: true }); });
        if (data.missing > 0 || data.offline) {
          const app = window.__app;
          app?.setStatus?.(app.t(data.offline ? 'bookEditor.offlineCopy' : 'bookEditor.missingPages', { n: data.missing }), false, 5000);
        }
        // Outline-IntersectionObserver nach Render bauen + Scroll-Fade-Scrollbar
        // am Inhaltsverzeichnis (gleiches Auto-Hide-Pattern wie der Sidebar-Tree).
        this.$nextTick(() => {
          this._initOutlineObserver();
          window.__app?._bindScrollFade?.(this.$root.querySelector('.book-editor-outline'));
          if (this.findOpen) this.recomputeFindMatches();
        });
        // Verankerte Leser-Kommentare des Buchs laden + über den Stream auflösen.
        this._loadBookComments();
        this._loadHeads(bookId, token);
      } catch (e) {
        if (token !== this._loadToken) return;
        this.loading = false;
        this.loadError = e?.body ? tErrorRaw(e.body) : window.__app?.t?.('bookEditor.loadFailed') || '';
      }
    },

    ...bookEditorCommentsMethods,
    ...bookEditorSaveMethods,
    ...bookEditorConflictMethods,
    ...bookEditorFindMethods,
    ...bookEditorOutlineMethods,
    ...bookEditorHistoryMethods,
    ...bookEditorHeadMethods,
    ...bookEditorDraftMethods,
    ...bookEditorActivationMethods,
    // `_memo(key, deps, fn)`; Reset über this._memos = {} im Lade-Pfad.
    ...memoMethods,

    // pageId → Page-Block. Index statt blocks.find() an fünf Stellen: bei einem
    // Buch mit hunderten Blöcken läuft der Linearscan sonst auch pro Save-
    // Queue-Schritt und pro Replace-Treffer.
    _blockById(pageId) {
      return this._memo('blockIndex', [this.blocks], () => {
        const map = new Map();
        for (const b of this.blocks) if (b.kind === 'page') map.set(b.pageId, b);
        return map;
      }).get(pageId) || null;
    },

    // ── Aggregate ─────────────────────────────────────────────────────────
    // Abgeleitet statt handgepflegt: Zähler, die an sechs Stellen inkrementiert
    // und dekrementiert werden, driften irgendwann gegen die Wahrheit in
    // `blocks` (die Math.max(0, …)-Pflaster waren genau dieses Symptom).
    get dirtyCount() {
      let n = 0;
      for (const b of this.blocks) if (b.dirty) n++;
      return n;
    },

    get savingCount() {
      let n = 0;
      for (const b of this.blocks) if (b.saving) n++;
      return n;
    },

    get saveAllTotal() { return this.saveAllIds.length; },

    get saveAllDone() {
      let n = 0;
      for (const id of this.saveAllIds) if (!this._blockById(id)?.dirty) n++;
      return n;
    },

    // ── Save-Queue ────────────────────────────────────────────────────────
    // _markBlockDirty / _enqueueSave / _processQueue / _saveBlock /
    // saveAllDirty / Konflikt-Auflösung / Status: cards/book-editor/save.js.

    // ── Outline / TOC ─────────────────────────────────────────────────────
    // Gliederung aus blocks (Aufbau: book-editor/outline.js#buildOutlineNodes).
    // Memoized auf die Block-Liste — Namen/Struktur ändern sich nur beim Laden,
    // der Per-Item-Status kommt reaktiv über `outlinePageStatus`.
    get outlineNodes() {
      return this._memo('outlineNodes', [this.blocks], () => buildOutlineNodes(this.blocks));
    },

    onFindKeydown(event) {
      if (event.key === 'Escape') { event.preventDefault(); this.closeFind(); return; }
      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) this.findPrev();
        else this.findNext();
      }
    },

    // Cmd/Ctrl+F läuft global über editor-find-card → book-editor:open-find.
    // Hier nur Cmd/Ctrl+S für Save-All.
    onCardKeydown(event) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.shiftKey && !event.altKey && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        this.saveAllDirty();
      }
    },

    // Ganze Bucheditor-Karte ins Native-Vollbild — mehr Platz für den Stream.
    // Status-Sync via fullscreenchange-Listener in init() (bookEditorFullscreen).
    async toggleBookEditorFullscreen() {
      try {
        await toggleWrapFullscreen(this.$root);
      } catch {
        const app = window.__app;
        app?.setStatus?.(app.t('bookEditor.error.fullscreen'), true, 4000);
      }
    },

  }));
}
