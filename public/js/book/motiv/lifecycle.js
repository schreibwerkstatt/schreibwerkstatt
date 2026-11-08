// Motiv-Werkstatt — Lifecycle + abgeleitete Werte. Lädt den Graph-Payload
// (Themen + Motive mit Soll-Links & Ist-Count + Beziehungen) und hält die
// abgeleiteten Aggregate memoized. Rein rückwärtsgewandt/planend.

import { fetchJson } from '../../utils.js';
import { memoMethods } from '../../cards/card-memo.js';
import { loadToken } from '../../cards/book-guard.js';

export const lifecycleMethods = {
  // Memo-Helper (cards/card-memo.js); Reset über this._memos = {}.
  ...memoMethods,

  // Buchwechsel-/Doppel-Load-Guard: eine verspätete Antwort des vorigen Buchs
  // setzte sonst dessen _savedPositions, und der nächste Drag schriebe das
  // Layout des alten Buchs unter dem neuen zurück.
  async loadBoard() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) return;
    const isCurrent = loadToken(this, '_boardLoadSeq', bookId);
    this.loading = true;
    this.errorMessage = '';
    try {
      const data = await fetchJson(`/motifs?book_id=${bookId}`);
      if (!isCurrent()) return;
      this.themes = data.themes || [];
      this.motifs = data.motifs || [];
      this.relations = data.relations || [];
      this.embedIndexStale = !!data.embedIndex?.stale;
      this._savedPositions = data.layout || {};
      this._memos = {};
      this._reconcileThemeBuffers();
      // Fundstellen-Cache des Verlaufsbands verwerfen: die Zellzahlen kommen
      // frisch aus diesem Payload, die aufgelösten Stellen müssen dazu passen.
      this.bandOccCache = {};
      this._bandOccGen++;
      this.activeBandDetailKey = null;
      // Beats + Werkstatt-Figuren der Verknüpfungs-Comboboxen einmal pro Board-
      // Load frisch (in der Plot-Werkstatt neu angelegte erscheinen sonst nie);
      // geholt wird erst, wenn ein Motiv gewählt ist (_ensureBeats/-DraftFiguren).
      this._beatsLoaded = false;
      this._draftFigurenLoaded = false;
      // Persistierte KI-Brainstorm-Läufe (Historie) mitladen.
      this.loadBrainstormRuns();
      // Konsistenz-Befunde mitziehen (deterministisch + billig, kein KI-Lauf) —
      // so trägt der Reiter seine Zahl, ohne dass man ihn erst öffnen muss. Die
      // Befund-Kanten der Konstellation zeichnet loadMotifChecks nach Ankunft nach.
      this.loadMotifChecks();
      // Persistierte KI-Prüfungs-Läufe (Historie) mitladen.
      this.loadConsistencyRuns();
      // Ideen-Plaketten (eigene Pendenzen an einem Motiv) — non-fatal.
      this.loadIdeaBacklinks('motif');
      // Figuren fürs Figuren-Layer + Verknüpfungs-Combobox bereitstellen.
      if (!this.$store.catalog.figuren?.length) window.__app.loadFiguren(bookId);
      this.$nextTick(() => this.renderMotivGraph());
      // Geparkter Cross-Card-Sprung (motiv:select vor dem Board-Load) → jetzt auswählen.
      if (this._pendingMotifId) {
        const pid = this._pendingMotifId;
        this._pendingMotifId = null;
        if (this.motifById(pid)) this.selectMotif(pid);
      }
    } catch (e) {
      if (isCurrent()) this.errorMessage = window.__app.t('motiv.error.load');
    } finally {
      if (isCurrent.latest()) this.loading = false;
    }
  },

  resetMotiv() {
    this._destroyGraph();
    this.themes = [];
    this.motifs = [];
    this.relations = [];
    this.selectedMotifId = null;
    this.selectedThemeId = null;
    this.motivView = 'graph';
    this.activeBandDetailKey = null;
    this.bandOccCache = {};
    this._bandOccGen++;
    this.bandExpanded = {};
    this.bandDetailLoading = false;
    this.checks = [];
    this.checksScanned = true;
    this.selectedCheckIdx = null;
    this.consistencyResult = null;
    this.consistencyRuns = [];
    this.selectedConsistencyRunId = null;
    this.selectedKonfliktIdx = null;
    this.occurrences = [];
    this.editThemeName = '';
    this.editThemeBeschreibung = '';
    this.editThemeId = '';
    this.editName = '';
    this.editBeschreibung = '';
    this.editTriggerTerms = [];
    this.newTriggerTerm = '';
    this.triggerRescanMotifId = null;
    this.occSourceFilter = '';
    this.motivQuery = '';
    this.editFigures = [];
    this.editDraftFigures = [];
    this.editBeats = [];
    this.editChapters = [];
    this.editPages = [];
    this.allBeats = [];
    this.allActs = [];
    this._beatsLoaded = false;
    this.allDraftFiguren = [];
    this._draftFigurenLoaded = false;
    this.errorMessage = '';
    this.embedIndexStale = false;
    this.suggestions = [];
    this.brainstormRuns = [];
    this.selectedBrainstormRunId = null;
    this._savedPositions = null;
    this._pendingMotifId = null;
    // Lauf-Flags der Jobs: die Poll-Timer räumt setupCardLifecycle (timerKeys)
    // vorher ab — ohne Reset bliebe der Button des neuen Buchs gesperrt.
    this.scanning = false;
    this.indexing = false;
    this.brainstorming = false;
    this.consistencyRunning = false;
    this._memos = {};
  },

  // ── Abgeleitete Werte ─────────────────────────────────────────────────────

  motifById(id) {
    return this.motifs.find(m => m.id === id) || null;
  },

  selectedMotif() {
    return this.selectedMotifId ? this.motifById(this.selectedMotifId) : null;
  },

  themeById(id) {
    return this.themes.find(t => t.id === id) || null;
  },

  selectedTheme() {
    return this.selectedThemeId ? this.themeById(this.selectedThemeId) : null;
  },

  // Thema-Auswahlen, die auf ein inzwischen gelöschtes Thema zeigen, leeren —
  // sonst hielte der Motiv-Puffer die tote ID (Speichern-Knopf ohne Änderung,
  // Save mit ungültiger theme_id) und die Anlege-Leiste ein verschwundenes Thema.
  _reconcileThemeBuffers() {
    const gone = (v) => v && !this.themeById(Number(v));
    if (gone(this.editThemeId)) this.editThemeId = '';
    if (gone(this.newMotifThemeId)) this.newMotifThemeId = '';
  },

  // Soll-Verknüpfungen über alle fünf Brücken (Katalog- UND Werkstatt-Figuren).
  // SSoT für Geist-Erkennung, Tooltip, Baum und Gliederung.
  motifLinkCount(m) {
    return (m.figures?.length || 0) + (m.draftFigures?.length || 0)
      + (m.beats?.length || 0) + (m.chapters?.length || 0) + (m.pages?.length || 0);
  },

  // Ein Motiv gilt als „geplant, aber fehlt" (Geist), wenn es Soll-Verknüpfungen
  // hat, aber die KI-Erkennung 0 Fundstellen fand — und nur, wenn überhaupt
  // gescannt wurde (checksScanned aus GET /motifs/consistency): ungescannt ist
  // ungeprüft, nicht abwesend. Gleiche Regel wie Server-Messung und Buch-Chat.
  isGhost(m) {
    return this.checksScanned && this.motifLinkCount(m) > 0 && (m.occurrenceCount || 0) === 0;
  },

  // Kopfzeile «12 Motive · 3 Themen · 9 im Text · 2 fehlend» — je Zahl eine
  // eigene Zählform (sonst «1 Motive»).
  motivStatsLabel() {
    const s = this.motivStats();
    const app = window.__app;
    return [
      app.tn('motiv.stats.motifs', s.motifs),
      app.tn('motiv.stats.themes', s.themes),
      app.t('motiv.stats.withOcc', { n: s.withOcc }),
      app.t('motiv.stats.ghosts', { n: s.ghosts }),
    ].join(' · ');
  },

  motivStats() {
    return this._memo('stats', [this.motifs, this.themes, this.checksScanned], () => {
      const withOcc = this.motifs.filter(m => (m.occurrenceCount || 0) > 0).length;
      const ghosts = this.motifs.filter(m => this.isGhost(m)).length;
      return { motifs: this.motifs.length, themes: this.themes.length, withOcc, ghosts };
    });
  },

  // Themen-Optionen fürs Combobox (leere Option = „ohne Thema").
  themeOptions() {
    return this._memo('themeOptions', [this.themes], () =>
      this.themes.map(t => ({ value: String(t.id), label: t.name })));
  },
};
