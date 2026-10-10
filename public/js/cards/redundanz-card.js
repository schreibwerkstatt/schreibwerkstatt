// Alpine.data('redundanzCard') — Redundanz-Radar (buchweite Doppelungs-Suche),
// Tab „Doppelungen" der Buchlandkarte (Hülle: partials/buchlandkarte.html).
// Job-Polling implementiert das Panel selbst (manueller Flow, inkl. Wieder-
// anhängen an einen laufenden Job beim Öffnen der Karte). Fachlicher State lebt
// hier; showBuchlandkarteCard + buchlandkarteTab bleiben im Root (Hash-Router,
// Exklusivität).

import { redundanzMethods } from '../book/redundanz.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerRedundanzCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('redundanzCard', () => ({
    redundanzThreshold: 'loose', // 'strict' | 'medium' | 'loose' — Default locker (zeigt auch thematisch Nahes)
    redundanzResult: null,
    redundanzLoading: false,
    redundanzProgress: 0,
    redundanzStatus: '',
    redundanzIndexInfo: null,
    redundanzSkipAdjacent: true, // direkt aufeinanderfolgende Seiten im selben Kapitel nicht als Befund
    redundanzOpen: {},           // aufgeklappte Passagen, key = Paar + Seite
    redundanzDismissedCount: 0,
    redundanzBusyKey: null,
    redundanzMergeKey: null,     // Figuren-Paar mit offener Richtungswahl (Zusammenführen)
    redundanzIndexing: false,
    redundanzIndexProgress: 0,
    _redundanzPollTimer: null,
    _redundanzIndexPollTimer: null,
    _lifecycle: null,

    // Getter inline (nicht in redundanzMethods gespreadet — Spread-Getter-Falle):
    // Backend + Buch vorhanden (Vektoren leben pro Buch).
    get redundanzAvailable() {
      return !!this.$store.config?.semanticSearchEnabled && !!Alpine.store('nav').selectedBookId;
    },
    // Ob ein Seiten-Index existiert (nur Seiten werden verglichen).
    get redundanzHasIndex() {
      const bk = this.redundanzIndexInfo?.byKind || [];
      return bk.some(k => k.kind === 'page' && k.chunks > 0);
    },

    init() {
      const doReset = (ctx) => {
        ctx.redundanzResult = null;
        ctx.redundanzLoading = false;
        ctx.redundanzProgress = 0;
        ctx.redundanzStatus = '';
        ctx.redundanzIndexInfo = null;
        ctx.redundanzOpen = {};
        ctx.redundanzDismissedCount = 0;
        ctx.redundanzBusyKey = null;
        ctx.redundanzMergeKey = null;
        ctx.redundanzIndexing = false;
        ctx.redundanzIndexProgress = 0;
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'redundanz',
        showFlag: 'showBuchlandkarteCard',
        timerKeys: ['_redundanzPollTimer', '_redundanzIndexPollTimer'],
        onShow: async () => {
          if (this.redundanzAvailable) await this.loadRedundanz();
        },
        onBookChanged: async (e, ctx, root) => {
          doReset(ctx);
          if (!root.showBuchlandkarteCard) return;
          if (ctx.redundanzAvailable) await ctx.loadRedundanz();
        },
        onViewReset: (e, ctx) => doReset(ctx),
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...redundanzMethods,
  }));
}
