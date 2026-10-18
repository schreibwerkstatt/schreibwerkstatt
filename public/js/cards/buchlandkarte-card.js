// Alpine.data('buchlandkarteCard') — Tabs „Landkarte" und „Verlauf" der
// Buchlandkarte (Abschnitte als Punktwolke bzw. als Ähnlichkeitsmatrix über dem
// Embedding-Index; beide aus EINEM Job-Ergebnis, darum eine Komponente; Hülle:
// partials/buchlandkarte.html, dritter Tab „Doppelungen" = redundanz-card.js). Job-Polling implementiert das Panel selbst
// (manueller Flow). Fachlicher State lebt hier; showBuchlandkarteCard +
// buchlandkarteTab bleiben im Root (Exklusivität, Hash-Router).

import {
  buchlandkarteMethods, _destroyBookMapChart, _disconnectBookMapThemeObserver, emptyBookMapPoles,
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
    // Optionen des nächsten Laufs: Punkte je Abschnitt oder je Passage, Achsen
    // aus der PCA oder aus eigenen Polen (vier Slots: x-Paar, y-Paar).
    bookMapGranularity: 'page',
    bookMapAxisMode: 'pca',
    bookMapPoles: emptyBookMapPoles(),
    // Anzeige des Ergebnisses: gezeigtes Achsenpaar ('0-1', '0-order', …) und
    // Färbung ('chapter' | 'order').
    bookMapAxisPair: '0-1',
    bookMapColorMode: 'chapter',
    // KI-Benennung der PCA-Achsen ([{ neg, pos, diff }] je Achse).
    bookMapLabels: null,
    bookMapLabelLoading: false,
    bookMapLabelStatus: '',
    // Matrix: Zelle unter dem Zeiger bzw. per Klick gewählt ({ row, col, score }).
    bookMapMatrixHover: null,
    bookMapMatrixPick: null,
    _bookMapPollTimer: null,
    _bookMapLabelPollTimer: null,
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
        for (const k of ['_bookMapPollTimer', '_bookMapLabelPollTimer']) {
          if (ctx[k]) { clearInterval(ctx[k]); ctx[k] = null; }
        }
        _destroyBookMapChart();
        ctx.bookMapResult = null;
        ctx.bookMapLoading = false;
        ctx.bookMapProgress = 0;
        ctx.bookMapStatus = '';
        ctx.bookMapIndexInfo = null;
        ctx.bookMapIndexError = false;
        ctx.bookMapFocusChapter = null;
        ctx.bookMapPoles = emptyBookMapPoles();
        ctx.bookMapAxisMode = 'pca';
        ctx.bookMapLabels = null;
        ctx.bookMapLabelLoading = false;
        ctx.bookMapLabelStatus = '';
        ctx.bookMapMatrixHover = null;
        ctx.bookMapMatrixPick = null;
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'buchlandkarte',
        showFlag: 'showBuchlandkarteCard',
        timerKeys: ['_bookMapPollTimer', '_bookMapLabelPollTimer'],
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

      // Im versteckten Tab hat das Canvas keine Grösse — beim Wechsel auf
      // Landkarte oder Verlauf neu zeichnen, statt auf den ResizeObserver von
      // Chart.js zu hoffen.
      this.$watch(() => window.__app?.buchlandkarteTab, (tab) => {
        if ((tab === 'map' || tab === 'matrix') && this.bookMapResult) this.$nextTick(() => this._renderBookMapTab());
      });
      // Achsenpaar oder Färbung gewechselt: dieselben Daten, neues Bild.
      this.$watch('bookMapAxisPair', () => { if (this.bookMapResult) this.$nextTick(() => this.renderBookMap()); });
      this.$watch('bookMapColorMode', () => { if (this.bookMapResult) this.$nextTick(() => this.renderBookMap()); });
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
