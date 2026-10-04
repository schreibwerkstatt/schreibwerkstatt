// Alpine.data('figurWerkstattCard') — Sub-Komponente der Figuren-Werkstatt-Karte.
// CRUD + jsMind-Editor + KI-Brainstorm + Konsistenz-Check.
// Root behält showFigurWerkstattCard, selectedBookId, t, appConfirm.

import { figurWerkstattMethods } from '../figur-werkstatt.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync } from '../fullscreen.js';
import { befundSeverityMethods } from '../utils/befund-severity.js';
import { ideenBacklinkMethods } from '../book/ideen-backlinks.js';

export function registerFigurWerkstattCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('figurWerkstattCard', () => ({
    drafts: [],
    selectedDraftId: null,
    selectedKnotenId: null,
    creating: false,
    newName: '',
    editName: '',
    editArchetype: '',
    editNotes: '',
    loading: false,
    busy: false,
    errorMessage: '',
    // Overflow-"⋯"-Menü der Detail-Header-Leiste (Brainstorm + Konsistenz).
    werkstattMenuOpen: false,
    brainstormLoading: false,
    brainstormProgress: 0,
    brainstormStatus: '',
    brainstormResult: null,
    consistencyLoading: false,
    consistencyProgress: 0,
    consistencyStatus: '',
    consistencyResult: null,
    mindmapFullscreen: false,
    contextMenuOpen: false,
    contextMenuNodeId: null,
    contextMenuPos: { left: 0, top: 0 },
    importing: false,
    importables: [],
    importablesLoading: false,
    selectedImportFigureId: '',
    // Nachtraegliche Verknuepfung Draft → Katalog-Figur (source_figure_id):
    // der Weg fuer alle, die erst geplant und dann geschrieben haben.
    linking: false,
    linkCandidates: [],
    linkCandidatesLoading: false,
    selectedLinkFigureId: '',
    runs: { brainstorm: [], consistency: [] },
    runsLoadedDraftId: null,
    runsLoading: false,
    // Cross-Feature: Plot-Beteiligung der ausgewählten Figur ({ beatCount,
    // activeBeatCount, threads }) fürs „in N Beats geplant"-Badge → Navigation Plot.
    plotUsage: null,
    // Cross-Feature: eigene Ideen je Werkstatt-Figur (idea_links target_kind 'draft'),
    // geladen in loadDrafts (non-fatal) — Map draft_id → Ideen-Anrisse.
    ideaBacklinks: {},
    // Cross-Feature: Motiv-Beteiligung der ausgewählten Figur ({ motifCount,
    // belegteCount, motifs }) fürs „trägt N Motive"-Badge → Motiv-Werkstatt.
    motifUsage: null,
    // Bogen im Buch: Ist-Index + Messung aller Werkstatt-Figuren des Buchs
    // ({ drafts, befunde, scanned, stale, kerne }) aus GET /draft-figures/:b/arc.
    // null = noch nicht geladen ODER Ladefehler; das Band zeigt dann seinen
    // Leerzustand statt einer Tabelle aus Nullen.
    arc: null,
    // Fundstellen-Detail einer Band-Zelle (kern:chapterId) + Fundstellen-Cache
    // pro Draft (eine Bandzeile hat so viele Zellen wie das Buch Kapitel).
    activeArcDetailKey: null,
    arcOccCache: {},
    arcDetailLoading: false,
    anchorLoading: false,
    anchorProgress: 0,
    anchorStatus: '',
    selectedRunId: null,
    selectedKonfliktIdx: null,
    _runsLoadDraftId: null,
    // Mindmap-Dirty als Generationszähler (crud.js#_markMindmapDirty).
    _mindmapGen: 0,
    _mindmapSavedGen: 0,
    // Schlüssel der x-for-Hülle um das Canvas: hochzählen erzwingt einen
    // Remount bei gleicher Draft-ID (Refresh mit Verwerfen).
    _mindmapMountKey: 0,
    _jm: null,
    _jmDraftId: null,
    _mindmapEl: null,
    _topicMarkers: null,
    _themeObs: null,
    _cancelLongPress: null,
    _brainstormJobId: null,
    _brainstormJobDraftId: null,
    _consistencyJobId: null,
    _consistencyJobDraftId: null,
    _brainstormPollTimer: null,
    _consistencyPollTimer: null,
    _anchorJobId: null,
    _anchorPollTimer: null,
    // Speicher des geteilten _memo-Helpers (cards/card-memo.js); pro Instanz.
    _memos: {},
    _ctxOutsideHandler: null,
    _ctxEscHandler: null,
    _pendingDraftId: null,
    _pendingKnotenId: null,
    _lifecycle: null,

    init() {
      // Sub → Store spiegeln: Hash-Router liest werkstattDraftId aus
      // Alpine.store('nav'). selectedDraftId bleibt SSoT in der Sub; jede Mutation
      // (selectDraft, resetState bei book:changed/view:reset, _doDelete) wird via
      // Watcher in den Store durchgereicht.
      this.$watch('selectedDraftId', (id) => {
        if (window.Alpine) window.Alpine.store('nav').werkstattDraftId = id || null;
      });
      // Drafts-Liste in den Store spiegeln, damit die Command-Palette
      // (figuren-Provider) auch werkstatt-Drafts findet, ohne selbst zu fetchen,
      // sobald die Karte mindestens einmal geladen hat.
      // Namensfeld → Wurzel-Knoten der Mindmap (die Wurzel IST die Figur).
      this.$watch('editName', (name) => this._syncRootTopic(name));
      this.$watch('drafts', (list) => {
        if (window.Alpine) window.Alpine.store('nav').werkstattDrafts = Array.isArray(list) ? list : [];
      });

      // Hash-Router → Sub: Permalink `#book/:b/werkstatt/:draftId` dispatcht
      // `figur-werkstatt:select`. Drafts evtl. noch nicht geladen → ID parken,
      // loadDrafts() wendet sie nach dem Fetch an.
      const onSelectDraft = (e) => {
        const id = parseInt(e.detail?.draftId);
        if (!id) return;
        const knotenId = e.detail?.knotenId || null;
        if (!this.drafts.length) {
          this._pendingDraftId = id;
          this._pendingKnotenId = knotenId;
          return;
        }
        if (!this.drafts.some(d => d.id === id)) return;
        if (this.selectedDraftId !== id) {
          this._pendingKnotenId = knotenId;
          this.selectDraft(id);
        } else if (knotenId) {
          this._selectNodeQuiet(knotenId);
        }
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'figurWerkstatt',
        showFlag: 'showFigurWerkstattCard',
        timerKeys: ['_brainstormPollTimer', '_consistencyPollTimer', '_anchorPollTimer'],
        // Kein resetState-Literal: der Reset dieser Karte muss die jsMind-
        // Instanz abraeumen, die Poll-Timer stoppen und ein offenes Vollbild
        // verlassen — das kann nur resetDrafts() (crud.js), und zwei Fassungen
        // desselben Resets driften. onBookChanged uebernimmt darum auch das
        // Nachladen, das der Default-Pfad sonst anhaengt.
        onBookChanged: async () => {
          this.resetDrafts();
          if (!window.__app?.showFigurWerkstattCard) return;
          if (!window.Alpine?.store('nav').selectedBookId) return;
          await this.loadDrafts();
        },
        onViewReset: () => this.resetDrafts(),
        load: () => this.loadDrafts(),
        onCardRefresh: async () => {
          if (this.isDirty()) {
            const ok = await window.__app.appConfirm({
              message: window.__app.t('werkstatt.confirmReload'),
              confirmLabel: window.__app.t('edit.discardEdit'),
              danger: true,
            });
            if (!ok) return;
          }
          await this.loadDrafts();
          // Wirklich verwerfen: Formular + Canvas aus dem frischen Server-Stand.
          this._reloadSelectedDraft();
        },
        extraListeners: [{
          type: 'keydown',
          handler: (e) => {
            if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
            if ((e.key || '').toLowerCase() !== 's') return;
            if (!window.__app?.showFigurWerkstattCard) return;
            if (!this.selectedDraftId) return;
            e.preventDefault();
            this.saveDraft();
          },
        }, {
          // Browser-Reload (F5/Cmd+R) und Tab-Close: native Prompt zeigen,
          // wenn Werkstatt geöffnet ist und ungespeicherte Änderungen vorliegen.
          // Custom appConfirm geht hier nicht — Browser blockiert Modals in
          // beforeunload. Pendant zum Editor-beforeunload in app.js.
          type: 'beforeunload',
          handler: (e) => {
            if (!window.__app?.showFigurWerkstattCard) return;
            if (!this.isDirty()) return;
            e.preventDefault();
            e.returnValue = '';
          },
        }, {
          type: 'figur-werkstatt:select',
          handler: onSelectDraft,
        }],
      });

      // Native Fullscreen-API: State spiegeln, jsMind resize bei Enter/Exit.
      attachFullscreenSync({
        resolveWrap: () => document.querySelector('.werkstatt-detail'),
        signal: this._lifecycle.signal,
        onChange: (active) => {
          this.mindmapFullscreen = active;
          if (this._jm) {
            try { this._jm.resize(); } catch {}
          }
        },
      });
    },

    destroy() {
      this._destroyMindmap();
      this._lifecycle?.destroy();
    },

    ...figurWerkstattMethods,
    // Schwere-Plakette der Konflikte + Bogen-Befunde (Befund-Skala, nicht Szenen-Stärke).
    ...befundSeverityMethods,
    ...ideenBacklinkMethods,
  }));
}
