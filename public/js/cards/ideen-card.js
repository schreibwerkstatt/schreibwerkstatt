// Alpine.data('ideenCard') — Sub-Komponente für Seiten- ODER Kapitel-Ideen.
// Scope-Switch via $app.ideenScope ('page'|'chapter'); $app.ideenChapterId
// nur in 'chapter'-Modus gesetzt. Lebt parallel zum Editor bzw. neben der
// Kapitelreview-Karte (kein _closeOtherMainCards).

import { ideenMethods } from '../book/ideen.js';
import { ideenLinkMethods } from '../book/ideen-links.js';
import { ideenCheckState, ideenCheckMethods } from '../book/ideen-check.js';
import { pickerPopoverState, pickerPopoverMethods } from '../picker-popover.js';
import { actionMenuState, actionMenuMethods } from '../action-menu.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { IDEE_STATUSES } from '../book/ideen-shared.js';
import { EVT } from '../events.js';
import { takeCardRequest, CARD_REQUEST } from './card-request.js';
import { applyQuoteToInput } from '../editor/aside-hotkeys.js';

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
    // Geometrie der Ideen-Popover (Verknuepfen, Verschieben/Zuordnen —
    // picker-popover.js).
    ...pickerPopoverState(),
    // Aktionsmenü einer Idee (action-menu.js), Ziel = Ideen-ID.
    ...actionMenuState(),
    // Auto-Erledigt-Check: Hinweise verwerfen, von Hand prüfen (book/ideen-check.js).
    ...ideenCheckState(),
    loading: false,
    busy: false,
    errorMessage: '',
    // Hinweis aufs Ideen-Board (book/ideen.js#_noteBoardHintPlace): Orte mit neuen
    // Ideen in dieser Sitzung, je Buch. Bewusst nicht in resetIdeen — der
    // Seitenwechsel ist genau der Moment, in dem gezaehlt werden soll.
    _boardHintPlaces: null,
    boardHintDue: false,
    // In dieser Karte wurde angelegt: nach einem Abschnittswechsel kehrt der
    // Cursor ins Feld zurueck (book/ideen.js#_refocusAfterPlaceChange).
    // Zurueckgesetzt erst beim Schliessen der Karte, nicht beim Seitenwechsel.
    _seriesActive: false,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showIdeenCard',
        // showNeedsBookId=false: Ideen sind seiten-/kapitel-, nicht buch-
        // gebunden — onShow soll auch greifen, wenn kein Buch in der Combobox
        // aktiv ist (currentPage bzw. ideenChapterId reicht).
        showNeedsBookId: false,
        timerKeys: ['_ideenCheckPollTimer'],
        onShow: async () => {
          // Ins Feld nur, wenn sich der Fokus während des Ladens nicht bewegt hat:
          // das Zitat-Kürzel fokussiert selbst, und wer schon mit Esc in den Text
          // zurück ist oder woanders klickt, bekäme ihn sonst entrissen.
          let focusMoved = false;
          const onFocus = () => { focusMoved = true; };
          document.addEventListener('focusin', onFocus, true);
          try {
            await this.loadIdeen();
          } finally {
            document.removeEventListener('focusin', onFocus, true);
          }
          this.$nextTick(() => {
            const ta = this.$el?.querySelector('.ideen-input');
            if (ta && !focusMoved) ta.focus();
            this._takeIdeenQuote();
          });
        },
        onHide: () => { this._seriesActive = false; },
        onBookChanged: () => this.resetIdeen(),
        onViewReset: () => this.resetIdeen(),
        extraListeners: [
          { type: EVT.IDEEN_STAGES_CHANGED, handler: (e) => this._onStagesChanged(e) },
          { type: EVT.CARD_REQUEST, handler: (e) => {
            if (e.detail?.key === CARD_REQUEST.IDEEN_QUOTE && window.__app.showIdeenCard) this._takeIdeenQuote();
          } },
          // Offline vorgemerkte Ideen sind auf dem Server: neu laden, damit die
          // temporären IDs den echten weichen (repo/ideen-queue.js).
          { type: EVT.IDEEN_QUEUE_CHANGED, handler: (e) => { if (e.detail?.flushed && window.__app.showIdeenCard) this.loadIdeen(); } },
        ],
      });

      // Page-Modus: Seitenwechsel triggert Reload (wenn offen).
      this.$watch(() => window.__app.currentPage?.id, async (pid) => {
        if (window.__app.ideenScope !== 'page') return;
        if (!pid) { this.resetIdeen(); return; }
        if (window.__app.showIdeenCard) { await this.loadIdeen(); this._refocusAfterPlaceChange(); }
      });

      // Chapter-Modus: Kapitelwechsel triggert Reload (wenn offen).
      this.$watch(() => window.__app.ideenChapterId, async (cid) => {
        if (window.__app.ideenScope !== 'chapter') return;
        if (!cid) { this.resetIdeen(); return; }
        if (window.__app.showIdeenCard) { await this.loadIdeen(); this._refocusAfterPlaceChange(); }
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
    },

    _relocate(scope) {
      const targetId = scope === 'chapter' ? 'kapitel-ideen-slot' : 'partial-ideen';
      const target = document.getElementById(targetId);
      if (target && this.$el.parentNode !== target) target.appendChild(this.$el);
    },

    destroy() {
      this._lifecycle?.destroy();
      this.closeActionMenu();
      this._releasePickerPopover();
    },

    // Markierung aus dem Text (⌘/Strg+Shift+2, editor/aside-hotkeys.js) als
    // Zitat ins Eingabefeld — gespeichert wird erst mit Enter.
    _takeIdeenQuote() {
      const text = takeCardRequest(CARD_REQUEST.IDEEN_QUOTE);
      if (text) applyQuoteToInput(this, 'newContent', this.$el?.querySelector('.ideen-input'), text);
    },

    ...ideenMethods,
    ...ideenLinkMethods,
    ...ideenCheckMethods,
    ...pickerPopoverMethods,
    ...actionMenuMethods,
  }));
}
