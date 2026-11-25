// Motiv-Werkstatt — KI-Brainstorm: die KI liest den Text und schlägt neue
// Motive/Themen vor. Vorschläge werden pro Lauf historisiert (motif_brainstorm_runs);
// der Autor übernimmt sie einzeln (→ Theme/Motiv anlegen) oder verwirft sie. Ein
// Lauf lässt sich später aus der Historie wieder öffnen. Nie im Text.

import { fetchJson, sendJson } from '../../utils.js';
import { startPoll, isCancelledJob } from '../../cards/job-helpers.js';
import { isSelectedBook } from '../../cards/book-guard.js';
import { makeRunHistoryMethods } from '../../run-history.js';

export const brainstormMethods = {
  // force=true verwirft den Delta-Cache und brainstormt das ganze Buch neu
  // („Neu einlesen" — frische kreative Vorschläge auch bei unverändertem Text).
  // Standard nutzt den Cache: nur geänderte Kapitel lösen einen KI-Call aus.
  async runBrainstorm(force = false) {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId || this.brainstorming) return;
    this.brainstorming = true;
    this.brainstormProgress = 0;
    this.brainstormStatus = '';
    this.errorMessage = '';
    try {
      const { jobId } = await fetchJson('/jobs/motif-brainstorm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, force: force === true }),
      });
      // Buch während des POST gewechselt: kein Poller mehr — er legte die
      // Vorschläge des alten Buchs ins neue, und «Übernehmen» legte sie dort an.
      if (!isSelectedBook(bookId)) return;
      this.motivBrainstormJobId = jobId;
      startPoll(this, {
        timerProp: '_brainstormPollTimer',
        jobId,
        progressProp: 'brainstormProgress',
        onProgress: (job) => { this.brainstormStatus = job.statusText ? window.__app.t(job.statusText, job.statusParams) : ''; },
        onDone: (job) => {
          this.brainstorming = false;
          this.brainstormStatus = '';
          this.motivBrainstormJobId = null;
          this.suggestions = (job.result?.vorschlaege || []);
          // Frisch persistierten Lauf als ausgewählt markieren + Historie neu laden.
          this.selectedBrainstormRunId = job.result?.runId || null;
          this.loadBrainstormRuns();
          // Panel + Historie stehen unten (überdecken den Graphen nicht) → hinscrollen.
          if (this.suggestions.length) this._scrollToSuggestions();
        },
        onNotFound: () => { this.brainstorming = false; this.brainstormStatus = ''; this.motivBrainstormJobId = null; },
        onError: (job) => {
          this.brainstorming = false;
          this.motivBrainstormJobId = null;
          // Abgebrochen ist kein Fehler: neutrale Statuszeile.
          if (isCancelledJob(job)) { this.brainstormProgress = 0; this.brainstormStatus = window.__app.t('job.cancelled'); return; }
          this.brainstormStatus = '';
          this.errorMessage = window.__app.t('motiv.error.brainstorm');
        },
      });
    } catch (e) {
      this.brainstorming = false;
      this.errorMessage = window.__app.t('motiv.error.brainstorm');
    }
  },

  // Vorschlags-Panel + Lauf-Auswahl leeren (geteilt von toggle-close/delete).
  _clearSuggestionPanel() {
    this.suggestions = [];
    this.selectedBrainstormRunId = null;
  },

  // Vorschlag verwerfen bzw. (discard=false) wieder anbieten — die Karte bleibt
  // im Panel stehen (Zustand am Vorschlag, `_state`). Rein lokal: der Lauf in der
  // Historie bietet beim Wiederöffnen wieder alles an.
  dismissSuggestion(s, discard = true) {
    if (!s || s._state === 'applied') return;
    s._state = discard ? 'discarded' : null;
  },

  // Noch offene Vorschläge (Hinweis «alle erledigt» bei 0).
  suggestionOpenCount() {
    return (this.suggestions || []).filter(s => !s._state).length;
  },

  // Vorschlag übernehmen → Theme bzw. Motiv anlegen (Undo-Record create-*), die
  // Karte bleibt als «übernommen» stehen.
  // Motiv-Vorschläge dürfen beim Übernehmen einem Thema zugeordnet werden
  // (s.themeIdDraft aus der Combobox in der Vorschlagskarte).
  // Doppelklick-Schutz je Vorschlag: der Server kennt keine Namens-Eindeutigkeit,
  // ein zweiter Klick legte das Motiv doppelt an. `adopting` steht am Vorschlag
  // selbst (die Karte bindet :disabled daran).
  async adoptSuggestion(s) {
    const bookId = this.$store.nav.selectedBookId;
    if (!s || s.adopting || s._state || !bookId || this._inHistoryFlight) return;
    s.adopting = true;
    try {
      if (s.typ === 'thema') {
        const theme = await sendJson('/motifs/themes', 'POST', { book_id: bookId, name: s.name, beschreibung: s.beschreibung });
        this._pushUndo({ kind: 'create-theme', id: theme?.id });
      } else {
        const body = { book_id: bookId, name: s.name, beschreibung: s.beschreibung, trigger_terms: s.trigger_terms || [] };
        if (s.themeIdDraft) body.theme_id = Number(s.themeIdDraft);
        const m = await sendJson('/motifs', 'POST', body);
        this._pushUndo({ kind: 'create-motif', id: m?.id });
      }
      s._state = 'applied';
      await this.loadBoard();
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
    finally { s.adopting = false; }
  },

  // ── Brainstorm-Lauf-Historie ───────────────────────────────────────────────
  // Persistierte Läufe pro Buch. Liste kommt ohne result_json (Spaltensparsam);
  // Detail wird beim Öffnen lazy geholt und ins bestehende Vorschlags-Panel
  // (suggestions) gelegt — genau wie ein frischer Lauf, sodass „Übernehmen" greift.
  ...makeRunHistoryMethods({
    names: { load: 'loadBrainstormRuns', open: 'openBrainstormRun', remove: 'deleteBrainstormRun', row: 'motivBrainstormRunRow' },
    list: 'brainstormRuns',
    selected: 'selectedBrainstormRunId',
    listUrl: (bookId) => `/motifs/brainstorm-runs?book_id=${bookId}`,
    runUrl: (id) => `/motifs/brainstorm-runs/${id}`,
    busy: (ctx) => ctx.brainstorming,
    apply: (ctx, detail) => { ctx.suggestions = detail.result.vorschlaege || []; },
    clear: (ctx) => ctx._clearSuggestionPanel(),
    afterOpen: (ctx) => ctx._scrollToSuggestions(),
    confirmKey: 'motiv.brainstorm.confirmDeleteRun',
    errorKeys: { open: 'motiv.error.runLoad', remove: 'motiv.error.runDelete' },
    row: {
      badges(r) { return [{ text: window.__app.tn('motiv.brainstorm.vorschlagCount', r.vorschlag_count) }]; },
    },
  }),

  // Zum Vorschlags-Panel scrollen (steht unten beim Verlauf). Geteilt von frischem
  // Lauf + Reopen, damit der geöffnete Lauf sichtbar wird, ohne den Graphen zu decken.
  _scrollToSuggestions() {
    this.$nextTick(() => this.$root?.querySelector('.motiv-suggestions')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  },
};
