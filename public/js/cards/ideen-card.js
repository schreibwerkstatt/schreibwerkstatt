// Alpine.data('ideenCard') — Sub-Komponente für Seiten- ODER Kapitel-Ideen.
// Scope-Switch via $app.ideenScope ('page'|'chapter'); $app.ideenChapterId
// nur in 'chapter'-Modus gesetzt. Lebt parallel zum Editor bzw. neben der
// Kapitelreview-Karte (kein _closeOtherMainCards).

import { ideenMethods } from '../book/ideen.js';
import { ideenLinkMethods } from '../book/ideen-links.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { IDEE_STATUSES } from '../book/ideen-shared.js';
import { EVT } from '../events.js';

export function registerIdeenCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('ideenCard', () => ({
    ideen: [],
    // Aktive Stufen des Buches (book_settings.ideen_stages), je Buch einmal
    // geladen (_loadStages in book/ideen.js).
    stages: [...IDEE_STATUSES],
    _stagesBookId: null,
    newContent: '',
    editingId: null,
    editingDraft: '',
    movingId: null,
    moveTargetId: '',

    // Verknuepfungs-Picker (ideen-links.js, geteilt mit dem Ideen-Board).
    linkTargets: {},
    _linkTargetsBookId: null,
    linkPickerIdeeId: null,
    linkPickerKind: 'research',
    linkPickerTargetId: '',
    // Popover-Geometrie des Pickers (nach <body> teleportiert, am Trigger
    // verankert — public/js/popover-anchor.js).
    linkPickerPos: { top: 0, left: 0 },
    _linkTriggerRect: null,
    _linkPickerCloseHandler: null,
    menuOpenId: null,
    menuPos: { top: 0, left: 0 },
    _menuCloseHandler: null,
    loading: false,
    busy: false,
    errorMessage: '',
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showIdeenCard',
        // showNeedsBookId=false: Ideen sind seiten-/kapitel-, nicht buch-
        // gebunden — onShow soll auch greifen, wenn kein Buch in der Combobox
        // aktiv ist (currentPage bzw. ideenChapterId reicht).
        showNeedsBookId: false,
        onShow: async () => {
          await this.loadIdeen();
          this.$nextTick(() => {
            const ta = this.$el?.querySelector('.ideen-input');
            if (ta) ta.focus();
          });
        },
        onBookChanged: () => this.resetIdeen(),
        onViewReset: () => this.resetIdeen(),
        extraListeners: [
          { type: 'ideen:reset', handler: () => this.resetIdeen() },
          { type: EVT.IDEEN_STAGES_CHANGED, handler: (e) => this._onStagesChanged(e) },
        ],
      });

      // Page-Modus: Seitenwechsel triggert Reload (wenn offen).
      this.$watch(() => window.__app.currentPage?.id, async (pid) => {
        if (window.__app.ideenScope !== 'page') return;
        if (!pid) { this.resetIdeen(); return; }
        if (window.__app.showIdeenCard) await this.loadIdeen();
      });

      // Chapter-Modus: Kapitelwechsel triggert Reload (wenn offen).
      this.$watch(() => window.__app.ideenChapterId, async (cid) => {
        if (window.__app.ideenScope !== 'chapter') return;
        if (!cid) { this.resetIdeen(); return; }
        if (window.__app.showIdeenCard) await this.loadIdeen();
      });

      // Kapitelreview-Kapitelwahl synchronisieren: wechselt User dort das
      // Kapitel (Combobox/Sidebar), wandert die Chapter-Ideen-Karte mit.
      this.$watch(() => window.__app.kapitelReviewChapterId, (cid) => {
        if (window.__app.ideenScope !== 'chapter') return;
        const id = parseInt(cid, 10);
        if (id) window.__app.ideenChapterId = id;
      });

      // Scope-Wechsel: State leeren + neu laden (falls Karte offen) +
      // Card-Element in passenden Slot verschieben (page → #partial-ideen
      // neben Editor, chapter → #kapitel-ideen-slot neben Kapitelreview).
      this.$watch(() => window.__app.ideenScope, async (scope) => {
        this._relocate(scope);
        this.resetIdeen();
        if (window.__app.showIdeenCard) await this.loadIdeen();
      });
      this.$nextTick(() => this._relocate(window.__app.ideenScope));

      // Move-Picker neben aktive Idee verschieben (DOM-Move, weil Combobox
      // in x-for nicht sauber initialisiert — daher Single-Panel ausserhalb).
      this.$watch('movingId', (id) => {
        const panel = this.$el.querySelector('.idee-move-panel');
        if (!panel) return;
        if (id === null) {
          const list = this.$el.querySelector('.ideen-list');
          if (list && panel.nextSibling !== list) this.$el.insertBefore(panel, list);
          return;
        }
        const item = this.$el.querySelector(`[data-idee-id="${id}"]`);
        if (item && item.parentNode) item.parentNode.insertBefore(panel, item.nextSibling);
      });
    },

    _relocate(scope) {
      const targetId = scope === 'chapter' ? 'kapitel-ideen-slot' : 'partial-ideen';
      const target = document.getElementById(targetId);
      if (target && this.$el.parentNode !== target) target.appendChild(this.$el);
    },

    destroy() {
      this._lifecycle?.destroy();
      this._detachMenuListeners?.();
      this._detachLinkPickerListeners?.();
    },

    ...ideenMethods,
    ...ideenLinkMethods,
  }));
}
