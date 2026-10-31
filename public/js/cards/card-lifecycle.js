import { EVT } from '../events.js';
import { takeCardRequest } from './card-request.js';
import { ownedFilterKeys, resetFilterScopes, restoreFilterScopes, watchFilterScopes } from '../filter-persist.js';

// Lade-Promises der Karten, die gerade eingeblendet wurden (Show-Watcher unten).
// `_withCardTransition` (app/app-view/_shared.js) wartet darauf, bevor der
// Cross-Fade den neuen Zustand aufnimmt — die Karte erscheint dann mit ihrem
// Inhalt, statt leer aufzugehen und Kacheln nachzuschieben.
const pendingShowLoads = new Set();

// Wartet auf alle laufenden Show-Loads, höchstens `maxMs` (danach blendet die
// Karte mit dem bis dahin geladenen Stand ein; der Rest lädt sichtbar nach).
export function settleShowLoads(maxMs) {
  if (!pendingShowLoads.size) return Promise.resolve();
  return Promise.race([
    Promise.allSettled([...pendingShowLoads]),
    new Promise(r => setTimeout(r, maxMs)),
  ]);
}
// Shared lifecycle helper for Buch-scoped Karten.
//
// Most Cards duplicate the same Pattern: clear timers + reset Meta-Flags on
// `book:changed` / `view:reset`, reload on `card:refresh`, and load on
// `showXxxCard`-watch. This helper centralises that.
//
// Usage:
//   import { setupCardLifecycle } from './card-lifecycle.js';
//
//   init() {
//     this._lifecycle = setupCardLifecycle(this, {
//       name: 'orte',                 // matches event.detail.name on card:refresh
//       showFlag: 'showOrteCard',     // root flag to watch
//       timerKeys: ['_ortePollTimer'],
//       resetState: { orteLoading: false, orteProgress: 0, orteStatus: '' },
//       load: (root) => root.loadOrte(Alpine.store('nav').selectedBookId),
//     });
//   },
//   destroy() { this._lifecycle.destroy(); },
//
// Optional cfg fields:
//   onShow(root)             — overrides default show-watch (which calls cfg.load)
//   onHide(root)             — runs when showFlag turns false
//   tabRequest               — { key, apply(value) }: Reiter-Wunsch aus
//                              card-request.js (Schluessel `CARD_REQUEST.*_TAB`).
//                              Der Helper holt ihn an allen drei Stellen ab:
//                              beim Mount (Karte erst durch den Sprung
//                              gemountet), synchron beim Einblenden VOR
//                              onShow/load (im selben Alpine-Flush wie `x-show`,
//                              sonst blitzt der gemerkte Reiter auf — das
//                              CARD_REQUEST-Event kommt erst nach dem Oeffnen)
//                              und auf das Event bei schon offener Karte.
//                              Karten rufen takeCardRequest fuer *_TAB nie
//                              selbst (gegated: card-tab-request-single-place).
//   beforeBookChanged(e, ctx, r) — awaited BEFORE the default reset+load on
//                              `book:changed`; the card still holds the old
//                              book's state (e.g. ask whether to save it)
//   onBookChanged(e, ctx, r) — override; skips the default reset+load
//                              (timerKeys are still cleared first)
//   onViewReset(e, ctx, r)   — override; skips the default reset
//                              (timerKeys are still cleared first)
//   onCardRefresh(e, ctx, r) — runs in place of cfg.load on `card:refresh`
//                              (name-match + book-id check are handled by helper)
//   resetState               — object or factory `() => ({…})` (see applyReset)
//   resetStateView           — override resetState specifically on `view:reset`
//   refreshNeedsBookId       — default true; set false if cfg.load checks itself
//   showNeedsBookId          — default true; set false to call onShow without book
//   extraListeners           — [{ type, handler(e) }] auto-attached + auto-removed
//   filterScopes             — [{ scope, key?, defaults }] (siehe filter-persist.js):
//                              Filterleisten dieser Karte, pro Buch im
//                              localStorage. Der Helper restauriert sie beim
//                              Mount und bei `book:changed` (VOR cfg.load, damit
//                              server-seitig filternde Karten gleich richtig
//                              laden), setzt sie bei `view:reset` auf Defaults
//                              und schreibt jede Mutation zurueck. Die Karte
//                              fasst diese Felder in ihren eigenen Reset-Pfaden
//                              NICHT an — `resetState` wird um sie bereinigt,
//                              eigene Reset-Methoden duerfen sie nicht setzen
//                              (sonst gewinnt der Default gegen den
//                              restaurierten Stand).
//
// Lifecycle returns { signal, destroy } — signal is the AbortController signal
// used internally; cards can attach their own listeners with `{ signal }` to get
// cleanup-for-free.
export function setupCardLifecycle(ctx, cfg) {
  const abort = new AbortController();
  const { signal } = abort;
  const root = () => window.__app;

  const clearTimers = () => {
    for (const k of cfg.timerKeys || []) {
      if (ctx[k]) { clearInterval(ctx[k]); ctx[k] = null; }
    }
  };
  // resetState darf ein Objekt ODER eine Factory sein. Factory bevorzugen,
  // sobald der Reset Arrays/Objekte enthält, die in-place mutiert werden
  // (`saveQueue.push`, `drafts[id] = …`): ein einmalig gebautes Literal teilt
  // seine Referenzen mit dem Live-State und schleppt beim nächsten Reset die
  // Mutationen des letzten Buchs wieder ein.
  // Felder, die die Filter-Persistenz besitzt: aus dem Reset-Payload streichen,
  // damit ein Karten-Reset den restaurierten Filterstand nicht ueberschreibt.
  // Die Karte darf sie weiter in ihrem Initial-State deklarieren (Regel „State
  // explizit deklariert") — nur zurueckgesetzt werden sie hier nicht mehr.
  const filterSpecs = cfg.filterScopes || [];
  const filterKeys = ownedFilterKeys(filterSpecs);
  const applyReset = (which) => {
    const src = which === 'view' && cfg.resetStateView
      ? cfg.resetStateView
      : cfg.resetState;
    let state = typeof src === 'function' ? src() : src;
    if (!state) return;
    if (filterKeys.size) {
      state = { ...state };
      for (const k of filterKeys) delete state[k];
    }
    Object.assign(ctx, state);
  };

  const applyTabRequest = () => {
    if (!cfg.tabRequest) return;
    const value = takeCardRequest(cfg.tabRequest.key);
    if (value != null && value !== '') cfg.tabRequest.apply(value);
  };

  if (cfg.showFlag && (cfg.load || cfg.onShow || cfg.onHide || cfg.tabRequest)) {
    ctx.$watch(() => root()[cfg.showFlag], async (visible) => {
      if (!visible) { if (cfg.onHide) await cfg.onHide(root()); return; }
      applyTabRequest();
      if (!cfg.load && !cfg.onShow) return;
      if (cfg.showNeedsBookId !== false && !Alpine.store('nav').selectedBookId) return;
      const pending = Promise.resolve(cfg.onShow ? cfg.onShow(root()) : cfg.load(root()));
      pendingShowLoads.add(pending);
      try { await pending; } finally { pendingShowLoads.delete(pending); }
    });
  }

  const defaultBookChanged = async (e) => {
    clearTimers();
    if (cfg.beforeBookChanged) await cfg.beforeBookChanged(e, ctx, root());
    applyReset('book');
    if (cfg.showFlag && !root()[cfg.showFlag]) return;
    if (!Alpine.store('nav').selectedBookId) return;
    if (cfg.load) await cfg.load(root());
  };
  const defaultViewReset = () => {
    clearTimers();
    applyReset('view');
  };

  // Overrides ersetzen Reset + Load, NICHT das Timer-Clearing: ein Poller des
  // alten Buchs, der weiterliefe, schriebe sein Ergebnis in die Karte des neuen.
  const onBookChanged = cfg.onBookChanged
    ? (e) => { clearTimers(); return cfg.onBookChanged(e, ctx, root()); }
    : defaultBookChanged;
  const onViewReset = cfg.onViewReset
    ? (e) => { clearTimers(); return cfg.onViewReset(e, ctx, root()); }
    : defaultViewReset;
  const onCardRefresh = (e) => {
    if (e.detail?.name !== cfg.name) return;
    if (cfg.refreshNeedsBookId !== false && !Alpine.store('nav').selectedBookId) return;
    if (cfg.onCardRefresh) cfg.onCardRefresh(e, ctx, root());
    else if (cfg.load) cfg.load(root());
  };

  // Filter-Persistenz VOR den Karten-Handlern anhaengen: Listener feuern in
  // Registrierungsreihenfolge, und eine Karte, die im `book:changed`-Handler
  // gleich nachlaedt (Recherche filtert serverseitig), muss den restaurierten
  // Stand schon sehen.
  if (filterSpecs.length) {
    const email = () => Alpine.store('session').currentUser?.email;
    const bookId = () => Alpine.store('nav').selectedBookId;
    restoreFilterScopes(ctx, filterSpecs, email(), bookId());
    window.addEventListener(EVT.BOOK_CHANGED, () => {
      restoreFilterScopes(ctx, filterSpecs, email(), bookId());
    }, { signal });
    window.addEventListener(EVT.VIEW_RESET, () => {
      resetFilterScopes(ctx, filterSpecs);
    }, { signal });
    watchFilterScopes(ctx, ctx, filterSpecs, { email, bookId });
  }

  window.addEventListener(EVT.BOOK_CHANGED, onBookChanged, { signal });
  window.addEventListener(EVT.VIEW_RESET, onViewReset, { signal });
  if (cfg.name) window.addEventListener(EVT.CARD_REFRESH, onCardRefresh, { signal });

  for (const { type, handler } of (cfg.extraListeners || [])) {
    window.addEventListener(type, handler, { signal });
  }

  if (cfg.tabRequest) {
    window.addEventListener(EVT.CARD_REQUEST, (e) => {
      if (e.detail?.key === cfg.tabRequest.key) applyTabRequest();
    }, { signal });
    applyTabRequest();
  }

  return {
    signal,
    destroy() {
      clearTimers();
      abort.abort();
    },
  };
}
