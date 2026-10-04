// Alpine.data('bookOverviewCard') — Default-Landing beim Öffnen eines Buchs.
// Reine Datenaggregation aus existierenden Endpoints; kein KI-Job.
// `showBookOverviewCard` lebt im Root (Hash-Router, Exklusivität).

import { bookOverviewMethods } from '../book-overview.js';
import { initialOverviewState } from '../book-overview/load.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { localIsoDate } from '../utils.js';

// Wie oft die Karte prüft, ob der Kalendertag gewechselt hat.
const DAY_TICK_MS = 60_000;

export function registerBookOverviewCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookOverviewCard', () => ({
    // Tile-State: SSoT ist initialOverviewState() in book-overview/load.js —
    // dieselbe Quelle, die resetBookOverview() beim Buchwechsel zurückschreibt.
    ...initialOverviewState(),

    _lifecycle: null,
    // Re-Entry-Guard für die Microtask-Koaleszierung unten (kein fachlicher State).
    _pendingBookId: null,
    // Re-Entry-Guards der Lade-Pipeline (book-overview/load.js). Deklariert,
    // weil Alpine nicht deklarierte Felder beim Schreiben an die äusserste
    // Scope hängt — sie lägen sonst als globaler Zustand auf `$app`.
    _loadingBookId: null,
    _staleCheckBookId: null,
    _statsSyncBookId: null,
    // Heutiger Kalendertag (appTimezone). Reaktive Abhängigkeit aller Kacheln,
    // die „heute" kennen (Heute-Ring, 7 Tage, Streak, Prognose, Tagebuch):
    // bleibt die Karte über Mitternacht offen, rechnen sie damit neu, statt den
    // Vortag als heute zu zeigen. Der Tick unten zieht den Wert nach.
    overviewToday: localIsoDate(),
    _dayTimer: null,
    // Memo-Speicher von cards/card-memo.js#_memo. Siehe Begruendung in
    // tagebuch-rueckblick-card.js: ohne Deklaration landet der Topf beim
    // Scope-Merge an der Root und wird zwischen Karten geteilt.
    _memos: {},

    init() {
      // Buchwechsel via Combobox feuert beide Events (`view:reset` sync aus
      // resetView, `book:changed` async aus _resetBookScopedState). Alle
      // Trigger laufen durch `scheduleLoad`, das per Microtask coalesciert
      // und dedupliziert — sonst Race zwischen Reset und neuem Load.
      const scheduleLoad = () => {
        const bookId = Alpine.store('nav').selectedBookId || null;
        if (!bookId) { this._pendingBookId = null; return; }
        // Schon gescheduled für diesen Buch → noop, sonst doppelter Load.
        if (this._pendingBookId === bookId) return;
        this._pendingBookId = bookId;
        queueMicrotask(() => {
          if (!window.__app?.showBookOverviewCard) { this._pendingBookId = null; return; }
          const target = this._pendingBookId;
          this._pendingBookId = null;
          if (target) this.loadBookOverview(target);
        });
      };

      this._lifecycle = setupCardLifecycle(this, {
        // `name` matcht `card:refresh { name }` — der Registry-Eintrag hat
        // `onReclick: 'refresh'`, ohne diesen Listener wäre der Re-Klick auf die
        // bereits offene Übersicht ein stiller No-Op.
        name: 'bookOverview',
        showFlag: 'showBookOverviewCard',
        onShow: scheduleLoad,
        // Arrays NICHT beim Buchwechsel leeren: alte Daten bleiben sichtbar,
        // bis der neue Load assignt — verhindert Tile-Flackern. Stale Antworten
        // verwirft loadBookOverview über den overviewBookId-Guard. Darum kein
        // `resetState`, sondern nur ein erneutes scheduleLoad.
        onBookChanged: scheduleLoad,
        // resetView setzt zuerst showBookOverviewCard=false, dann
        // _maybeOpenBookOverview wieder true — Alpine $watch coalesciert
        // false→true zu no-op, daher explizit nachschieben.
        onViewReset: scheduleLoad,
        // Re-Klick auf die offene Karte: harter Reload vom Server (der
        // Dedupe-Guard in loadBookOverview greift nur bei laufendem Load).
        // `fresh` umgeht zusaetzlich den geteilten Stats-/Settings-Cache im
        // progress-Store — sonst waere „nochmal laden" ein Cache-Treffer.
        onCardRefresh: () => this.loadBookOverview(Alpine.store('nav').selectedBookId, { fresh: true }),
      });

      this._dayTimer = setInterval(() => {
        const today = localIsoDate();
        if (today !== this.overviewToday) this.overviewToday = today;
      }, DAY_TICK_MS);
    },

    destroy() {
      this._lifecycle?.destroy();
      clearInterval(this._dayTimer);
      this._dayTimer = null;
    },

    ...bookOverviewMethods,
  }));
}
