// Alpine.data('kontinuitaetCard') — Sub-Komponente der Kontinuitätsprüfung.
// Job-Polling implementiert die Karte selbst (manueller Flow, kein createCardJobFeature).

import { kontinuitaetMethods } from '../book/kontinuitaet.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerKontinuitaetCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('kontinuitaetCard', () => ({
    kontinuitaetResult: null,
    kontinuitaetLoading: false,
    kontinuitaetProgress: 0,
    kontinuitaetStatus: '',
    // Laufender Prüf-Job: 'kontinuitaet' | 'faktencheck' | '' (Knopf-Beschriftung).
    kontinuitaetRunKind: '',
    // Teil-Degradierungen des letzten Standalone-Laufs: [{ key, params? }].
    kontinuitaetWarnings: [],
    // GET der Befunde fehlgeschlagen (ohne vorhandenes Ergebnis) → Retry-Zustand.
    kontinuitaetLoadError: false,
    selectedKontinuitaetIssueKey: null,
    // Namens-/Konsistenz-Waechter (regelbasiert, eigene Sektion in dieser Karte).
    nameGuardResult: null,
    nameGuardLoading: false,
    selectedNameGuardKey: null,
    _kontinuitaetPollTimer: null,
    // Memo-Speicher des Moduls (book/kontinuitaet.js#_memo): Kapitel-Index,
    // gefilterte + sortierte Befundliste. Wird bei jedem Daten-Reload geleert.
    _memos: {},
    _lifecycle: null,

    init() {
      // kontinuitaetFilters lebt in Alpine.store('catalogUi') (FILTER_SCOPES,
      // localStorage-Persist). Reset/Restore übernimmt der Root via
      // book:changed / view:reset.
      const doReset = (ctx) => {
        ctx._memos = {};
        ctx.kontinuitaetResult = null;
        ctx.kontinuitaetLoading = false;
        ctx.kontinuitaetProgress = 0;
        ctx.kontinuitaetStatus = '';
        ctx.kontinuitaetRunKind = '';
        ctx.kontinuitaetWarnings = [];
        ctx.kontinuitaetLoadError = false;
        ctx.selectedKontinuitaetIssueKey = null;
        ctx.nameGuardResult = null;
        ctx.nameGuardLoading = false;
        ctx.selectedNameGuardKey = null;
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'kontinuitaet',
        showFlag: 'showKontinuitaetCard',
        timerKeys: ['_kontinuitaetPollTimer'],
        onShow: async (root) => {
          if (!root.$store.catalog.figuren?.length) await root.loadFiguren(Alpine.store('nav').selectedBookId);
          await this._loadKontinuitaetHistory();
        },
        load: () => this._loadKontinuitaetHistory(),
        onBookChanged: async (e, ctx, root) => {
          doReset(ctx);
          if (!root.showKontinuitaetCard) return;
          if (!Alpine.store('nav').selectedBookId) return;
          await ctx._loadKontinuitaetHistory();
        },
        onViewReset: (e, ctx) => doReset(ctx),
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...kontinuitaetMethods,
  }));
}
