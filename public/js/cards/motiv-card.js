// Motiv-Werkstatt — Alpine.data-Sub-Komponente (Themen & Motive als Konstellation).
// State explizit deklariert; Fachmethoden aus public/js/book/motiv.js gespreadet.
// Root-Zugriffe via window.__app (JS) bzw. $app (Template).

import { motivMethods } from '../book/motiv.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { attachFullscreenSync } from '../fullscreen.js';
import { observeThemeChange } from '../graph-kit.js';
import { ideenBacklinkMethods } from '../book/ideen-backlinks.js';
import { actionMenuState, actionMenuMethods } from '../action-menu.js';

export function registerMotivCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('motivCard', () => ({
    // Daten (Graph-Payload)
    themes: [],

    // Ideen-Plaketten (Gegenrichtung der Ideen-Verknuepfung, read-only).
    // Map Ziel-ID → Ideen-Anrisse; geladen in loadIdeaBacklinks (non-fatal).
    ideaBacklinks: {},
    _ideaBacklinkBookId: null,
    motifs: [],
    relations: [],
    allBeats: [],
    allActs: [],
    // Werkstatt-Figuren (draft_figures) fürs Figuren-Verknüpfungs-Combobox (Gruppe „Plotwerkstatt")
    allDraftFiguren: [],
    // UI-Status
    loading: false,
    busy: false,
    errorMessage: '',
    // Auswahl + Fundstellen
    selectedMotifId: null,
    // Themen-Auswahl (parallel zur Motiv-Auswahl, gegenseitig exklusiv): Klick auf
    // ein Thema (Liste oder Graph-Knoten) öffnet den Themen-Editor im Panel.
    selectedThemeId: null,
    occurrences: [],
    occLoading: false,
    // Detail-Editor (Seitenpanel + Gliederung): gewählter Reiter (details | occ |
    // links | relations), kartenweit in localStorage gemerkt (detail.js).
    motivDetailTab: 'details',
    // Fundstellen-Reiter: Quelle filtern ('' = alle, 'semantic', 'trigger').
    occSourceFilter: '',
    // Motiv, dessen Trigger zuletzt gespeichert wurden und das noch nicht neu
    // gescannt ist — der Fundstellen-Reiter bietet dann „Nur dieses Motiv neu suchen" an.
    triggerRescanMotifId: null,
    // Suche über Baum (Seitenpanel) und Gliederung: Name, Beschreibung, Trigger.
    motivQuery: '',
    // Edit-Puffer der Kern-Felder (Name/Thema/Beschreibung/Trigger) — explizit
    // gespeichert via Save/Cancel-Leiste, kein Feld-Autosave. Trigger als Liste
    // (Chips) plus Eingabe-Draft.
    editThemeId: '',
    editName: '',
    editBeschreibung: '',
    editTriggerTerms: [],
    newTriggerTerm: '',
    // Edit-Puffer des Themen-Editors (Name/Beschreibung) — explizit gespeichert
    // via Save/Cancel, kein Feld-Autosave (App-Standard, wie der Motiv-Editor).
    editThemeName: '',
    editThemeBeschreibung: '',
    // Edit-Puffer der Soll-Verknüpfungen (Figuren/Beats/Kapitel/Seiten) — wie die
    // Kern-Felder explizit via Save/Cancel-Icon persistiert, kein Auto-Save mehr.
    // Bei Auswahl aus dem Motiv gefüllt (_loadLinkBuffer), Chips lesen die Puffer.
    editFigures: [],
    editDraftFigures: [],
    editBeats: [],
    editChapters: [],
    editPages: [],
    // Ansicht: Konstellation (Graph), Kapitel-Verlaufsband (Heatmap Motiv × Kapitel),
    // Konsistenz-Befunde (deterministische Messung der Motiv-Kanten) oder
    // Gliederung (bearbeitbare Baum-Tabelle Thema → Motiv)
    motivView: 'graph',
    // Kapitel-Verlaufsband — aufgeklapptes Zell-Detail (`motifId:chapterId`) und
    // die dafür geholten Fundstellen. Der Cache liegt pro Motiv (eine Bandzeile
    // hat so viele Zellen wie das Buch Kapitel) und wird bei jedem loadBoard()
    // geleert, weil ein Scan-Lauf die Zahlen darunter verschiebt.
    activeBandDetailKey: null,
    bandOccCache: {},
    // Aufgeklappte Hauptkapitel-Spalten des Bands (chapterId → true). Pro Buch;
    // Default zu (Spalten = oberste Kapitel, Teilbaum summiert).
    bandExpanded: {},
    bandDetailLoading: false,
    // Konsistenz-Befunde (GET /motifs/consistency — Messung, kein KI-Lauf).
    // checksScanned=false heisst: der Ist-Index ist leer, es wurde also nicht
    // gemessen — nicht „alles in Ordnung".
    checks: [],
    checksScanned: true,
    checksLoading: false,
    selectedCheckIdx: null,
    // KI-Urteil (Job `motif-consistency`) — zweite Schicht neben der Messung.
    // consistencyResult ist transient (frischer Lauf ODER wieder geöffneter
    // Lauf aus der Historie), consistencyRuns die persistierte Liste.
    consistencyRunning: false,
    consistencyProgress: 0,
    consistencyResult: null,
    consistencyRuns: [],
    selectedConsistencyRunId: null,
    selectedKonfliktIdx: null,
    motivConsistencyJobId: null,
    // Graph-Layer
    layerFigures: false,
    layerBeats: false,
    layerChapters: false,
    // Graph-Kontextmenü (Rechtsklick): Ziel = Knoten-ID, null = leere Fläche
    ...actionMenuState(),
    // Offener Thema-Farbwähler (Themen-Liste im Panel), null = keiner
    themeColorPickerId: null,
    // Eingabe-Drafts
    newThemeName: '',
    newMotifName: '',
    newMotifThemeId: '',
    // Schnellweg im Themen-Editor: Name des dort direkt anzulegenden Motivs.
    // Eigenes Feld statt newMotifName — die Toolbar-Eingabe ist gleichzeitig
    // sichtbar und würde sonst mitschreiben.
    newThemeMotifName: '',
    newRelationTargetId: '',
    newRelationTyp: '',
    // Scan-Job
    scanning: false,
    scanProgress: 0,
    motivScanJobId: null,
    // Breite des Seitenpanels neben der Konstellation (px, null = Default aus
    // dem CSS); per Griff gezogen, in localStorage gemerkt (panel-resize.js).
    motivPanelWidth: null,
    // Native-Fullscreen-Status (gespiegelt vom fullscreenchange-Listener) — mehr
    // Platz für die Konstellation. Toggle in graphMethods.toggleMotivFullscreen.
    motivFullscreen: false,
    // Embedding-Index-Refresh (für semantische Erkennung)
    indexing: false,
    // Ist der Embedding-Index des Buches veraltet? Server-gestützt aus loadBoard
    // (embedIndex.stale) — steuert den „Index aktualisieren"-Hinweis. Kein Session-
    // Flag: verschwindet, sobald der Index tatsächlich frisch ist (auch via Nacht-Cron).
    embedIndexStale: false,
    // Brainstorm-Job (KI-Vorschläge)
    brainstorming: false,
    motivBrainstormJobId: null,
    suggestions: [],
    // Brainstorm-Lauf-Historie (persistiert pro Buch); ein Eintrag lädt seine
    // Vorschläge zurück ins Panel (selectedBrainstormRunId markiert den offenen Lauf).
    brainstormRuns: [],
    selectedBrainstormRunId: null,
    // interne (nicht-reaktive) Felder
    // Cross-Feature-Sprung (Plot-Beat-Motiv-Badge → motiv:select): geparkte Motiv-ID,
    // falls das Board beim Event noch nicht geladen war; loadBoard wendet sie an.
    _pendingMotifId: null,
    _beatsLoaded: false,
    _draftFigurenLoaded: false,
    _memos: {},
    _boardLoadSeq: 0,  // Lade-Token (book-guard.js#loadToken)
    _motivNetwork: null,
    _motivNodes: null,
    _motivEdges: null,
    _motivHash: '',
    // Aufgelöste Canvas-Farben (Hell/Dunkel), pro Render in renderMotivGraph gesetzt.
    _graphTheme: null,
    _themeObserver: null,
    _scanPollTimer: null,
    _brainstormPollTimer: null,
    _consistencyPollTimer: null,
    _embedPollTimer: null,
    _layoutSaveTimer: null,
    // Buch, zu dem der ausstehende Layout-Save gehört (beim Planen gemerkt).
    _layoutSaveBookId: null,
    // Lade-Token der Nebenlesungen (Befunde, Läufe) gegen späte Antworten
    _checksLoadSeq: 0,
    _consistencyRunsSeq: 0,
    _brainstormRunsSeq: 0,
    // Generation des Band-Fundstellen-Caches: loadBoard/Reset zählen hoch, eine
    // vorher gestartete Lesung schreibt dann nicht in den frischen Cache.
    _bandOccGen: 0,
    // Laufender Beziehungs-Anlege-Request (Doppelklick-Schutz)
    _relationAdding: false,
    // Persistiertes Knoten-Layout (node_id → {x,y}); aus loadBoard, beim Ziehen gespeichert.
    _savedPositions: null,
    // SortableJS-Instanzen des Baums: Themen-Reihenfolge + je Gruppe eine
    // Motiv-Liste (Motive zwischen Themen ziehen)
    _themeSortable: null,
    _motifSortables: null,
    // Lade-Token der Fundstellen (selectMotif) gegen späte Antworten
    _occSeq: 0,
    // Laufender Motiv-Save (saveMotifEdit) — weitere Aufrufe warten darauf
    _motifSaving: null,
    _lifecycle: null,

    init() {
      // Cross-Card-Sprung: `motiv:select` (z.B. aus einem Plot-Beat-Motiv-Badge)
      // wählt das Motiv aus. Motive evtl. noch nicht geladen → ID parken,
      // loadBoard() wendet sie nach dem Fetch an.
      const onSelectMotif = (e) => {
        const id = parseInt(e.detail?.motifId);
        if (!id) return;
        if (this.selectedMotifId === id) return;
        if (this.motifById(id)) { this.selectMotif(id); return; }
        // Noch nicht geladen ODER seit dem letzten Load angelegt (Board veraltet):
        // parken und — bei offener Karte mit Board — frisch laden; loadBoard wendet
        // die geparkte ID an. Sonst ginge der Sprung still verloren.
        this._pendingMotifId = id;
        if (this.motifs.length && window.__app.showMotivCard) this.loadBoard();
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'motiv',
        showFlag: 'showMotivCard',
        // _layoutSaveTimer bewusst NICHT hier: ein ausstehender Drag-Save wird beim
        // Buchwechsel noch unter dem ALTEN Buch geschrieben (_flushLayoutSave),
        // statt verworfen zu werden.
        timerKeys: ['_scanPollTimer', '_brainstormPollTimer', '_consistencyPollTimer', '_embedPollTimer'],
        onShow: () => this.loadBoard(),
        // Wechsel = Save, kein stilles Verwerfen (wie beim Motivwechsel): offene
        // Puffer erst committen, dann zurücksetzen. Die Motiv-/Themen-Routen hängen
        // an der ID, nicht am gewählten Buch — der Save trifft das richtige Objekt.
        onBookChanged: async () => {
          this._flushLayoutSave();
          await this._commitPendingEdits();
          this.resetMotiv();
          if (window.__app.showMotivCard && this.$store.nav.selectedBookId) this.loadBoard();
        },
        onViewReset: async () => {
          this._flushLayoutSave();
          await this._commitPendingEdits();
          this.resetMotiv();
        },
        onCardRefresh: () => this.loadBoard(),
        extraListeners: [{ type: 'motiv:select', handler: onSelectMotif }],
      });

      this.motivDetailTab = this._readDetailTab();
      this.$watch('motivDetailTab', (v) => this._persistDetailTab(v));
      this.motivPanelWidth = this._readPanelWidth();

      // Theme-Wechsel (Hell/Dunkel) → Konstellation neu zeichnen. Die Farben
      // stecken im gezeichneten Canvas-Bild, ein CSS-Wechsel erreicht sie nicht.
      this._themeObserver = observeThemeChange(() => {
        if (window.__app.showMotivCard && this.motivView === 'graph') this.renderMotivGraph();
      });

      // Native Fullscreen-API: Status spiegeln (Toggle-Button + Esc-Exit) und den
      // vis-network-Graph auf die neue Containergrösse neu zeichnen.
      attachFullscreenSync({
        resolveWrap: () => this.$root,
        signal: this._lifecycle.signal,
        onChange: (active) => {
          this.motivFullscreen = active;
          // Container-Grösse ändert sich → Canvas erst nach dem Fullscreen-Reflow
          // neu vermessen (redraw) und die Ansicht einpassen (fit). Ohne fit bleibt
          // der Graph beim alten Viewport hängen und liegt ausserhalb der neuen
          // Fläche; rAF stellt sicher, dass das :fullscreen-Layout schon steht.
          requestAnimationFrame(() => {
            if (!this._motivNetwork) return;
            this._motivNetwork.redraw();
            this._motivNetwork.fit({ animation: { duration: 300 } });
          });
        },
      });
    },

    destroy() {
      // Ausstehende Layout-Speicherung noch flushen, solange das Netzwerk lebt.
      this._flushLayoutSave();
      this._destroyThemeSortable();
      this._destroyMotifSortables();
      this._themeObserver?.disconnect();
      this._themeObserver = null;
      this.closeActionMenu();
      this._destroyGraph();
      this._lifecycle?.destroy();
    },

    ...motivMethods,
    ...ideenBacklinkMethods,
    ...actionMenuMethods,
  }));
}
