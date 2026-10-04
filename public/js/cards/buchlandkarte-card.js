// Alpine.data('buchlandkarteCard') — Tab „Landkarte" der Buchlandkarte (Seiten
// als Punktwolke über dem Embedding-Index; Hülle: partials/buchlandkarte.html,
// zweiter Tab = redundanz-card.js). Job-Polling implementiert das Panel selbst
// (manueller Flow). Fachlicher State lebt hier; showBuchlandkarteCard +
// buchlandkarteTab bleiben im Root (Exklusivität, Hash-Router).

import {
  buchlandkarteMethods, _destroyBookMapChart, _disconnectBookMapThemeObserver,
} from '../book/buchlandkarte.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerBuchlandkarteCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('buchlandkarteCard', () => ({
    bookMapResult: null,
    bookMapLoading: false,
    bookMapProgress: 0,
    bookMapStatus: '',
    bookMapIndexInfo: null,
    // Status-Abfrage gescheitert: dann ist unbekannt, ob ein Index existiert —
    // die Karte darf weder „kein Index" behaupten noch den Lauf sperren.
    bookMapIndexError: false,
    // Hervorgehobenes Kapitel (Klick in der Kapitel-Tabelle); null = alle.
    bookMapFocusChapter: null,
    _bookMapPollTimer: null,
    _lifecycle: null,

    // Getter inline (nicht im gespreadeten Fachmodul — Spread-Getter-Falle):
    // Backend + Buch vorhanden (die Vektoren leben pro Buch).
    get bookMapAvailable() {
      return !!this.$store.config?.semanticSearchEnabled && !!Alpine.store('nav').selectedBookId;
    },
    // Ob ein SEITEN-Index existiert — nur Seiten werden projiziert.
    get bookMapHasIndex() {
      const bk = this.bookMapIndexInfo?.byKind || [];
      return bk.some(k => k.kind === 'page' && k.chunks > 0);
    },
    get bookMapCanRun() {
      return this.bookMapAvailable && (this.bookMapHasIndex || this.bookMapIndexError);
    },

    init() {
      const doReset = (ctx) => {
        if (ctx._bookMapPollTimer) { clearTimeout(ctx._bookMapPollTimer); ctx._bookMapPollTimer = null; }
        _destroyBookMapChart();
        ctx.bookMapResult = null;
        ctx.bookMapLoading = false;
        ctx.bookMapProgress = 0;
        ctx.bookMapStatus = '';
        ctx.bookMapIndexInfo = null;
        ctx.bookMapIndexError = false;
        ctx.bookMapFocusChapter = null;
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'buchlandkarte',
        showFlag: 'showBuchlandkarteCard',
        timerKeys: ['_bookMapPollTimer'],
        onShow: async () => {
          if (this.bookMapAvailable) await this.loadBookMapIndexStatus();
          this.restoreBookMapResult();
        },
        onBookChanged: async (e, ctx, root) => {
          doReset(ctx);
          if (!root.showBuchlandkarteCard) return;
          if (ctx.bookMapAvailable) await ctx.loadBookMapIndexStatus();
          ctx.restoreBookMapResult();
        },
        onViewReset: (e, ctx) => doReset(ctx),
      });

      // Im versteckten Tab hat das Canvas keine Grösse — beim Wechsel auf die
      // Landkarte neu zeichnen, statt auf den ResizeObserver von Chart.js zu hoffen.
      this.$watch(() => window.__app?.buchlandkarteTab, (tab) => {
        if (tab === 'map' && this.bookMapResult) this.$nextTick(() => this.renderBookMap());
      });
    },

    destroy() {
      // Chart-Instanz UND Theme-Observer liegen modulweit — ohne beides
      // überlebt der Observer das Unmount und zeichnet in ein totes Canvas.
      _destroyBookMapChart();
      _disconnectBookMapThemeObserver();
      this._lifecycle?.destroy();
    },

    ...buchlandkarteMethods,
  }));
}
