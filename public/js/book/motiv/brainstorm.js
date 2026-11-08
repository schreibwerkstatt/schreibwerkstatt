// Motiv-Werkstatt — KI-Brainstorm: die KI liest den Text und schlägt neue
// Motive/Themen vor. Vorschläge werden pro Lauf historisiert (motif_brainstorm_runs);
// der Autor übernimmt sie einzeln (→ Theme/Motiv anlegen) oder verwirft sie. Ein
// Lauf lässt sich später aus der Historie wieder öffnen. Nie im Text.

import { fetchJson, sendJson, tzOpts, localeTag } from '../../utils.js';
import { startPoll } from '../../cards/job-helpers.js';
import { loadToken, isSelectedBook } from '../../cards/book-guard.js';

export const brainstormMethods = {
  // force=true verwirft den Delta-Cache und brainstormt das ganze Buch neu
  // („Neu einlesen" — frische kreative Vorschläge auch bei unverändertem Text).
  // Standard nutzt den Cache: nur geänderte Kapitel lösen einen KI-Call aus.
  async runBrainstorm(force = false) {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId || this.brainstorming) return;
    this.brainstorming = true;
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
        onDone: (job) => {
          this.brainstorming = false;
          this.motivBrainstormJobId = null;
          this.suggestions = (job.result?.vorschlaege || []);
          // Frisch persistierten Lauf als ausgewählt markieren + Historie neu laden.
          this.selectedBrainstormRunId = job.result?.runId || null;
          this.loadBrainstormRuns();
          // Panel + Historie stehen unten (überdecken den Graphen nicht) → hinscrollen.
          if (this.suggestions.length) this._scrollToSuggestions();
        },
        onNotFound: () => { this.brainstorming = false; this.motivBrainstormJobId = null; },
        onError: () => { this.brainstorming = false; this.motivBrainstormJobId = null; this.errorMessage = window.__app.t('motiv.error.brainstorm'); },
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

  dismissSuggestion(s) {
    this.suggestions = this.suggestions.filter(x => x !== s);
  },

  // Vorschlag übernehmen → Theme bzw. Motiv anlegen, dann aus der Liste nehmen.
  // Motiv-Vorschläge dürfen beim Übernehmen einem Thema zugeordnet werden
  // (s.themeIdDraft aus der Combobox in der Vorschlagskarte).
  // Doppelklick-Schutz je Vorschlag: der Server kennt keine Namens-Eindeutigkeit,
  // ein zweiter Klick legte das Motiv doppelt an. `adopting` steht am Vorschlag
  // selbst (die Karte bindet :disabled daran).
  async adoptSuggestion(s) {
    const bookId = this.$store.nav.selectedBookId;
    if (!s || s.adopting || !bookId) return;
    s.adopting = true;
    try {
      if (s.typ === 'thema') {
        await sendJson('/motifs/themes', 'POST', { book_id: bookId, name: s.name, beschreibung: s.beschreibung });
      } else {
        const body = { book_id: bookId, name: s.name, beschreibung: s.beschreibung, trigger_terms: s.trigger_terms || [] };
        if (s.themeIdDraft) body.theme_id = Number(s.themeIdDraft);
        await sendJson('/motifs', 'POST', body);
      }
      this.dismissSuggestion(s);
      await this.loadBoard();
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
    finally { s.adopting = false; }
  },

  // ── Brainstorm-Lauf-Historie ───────────────────────────────────────────────
  // Persistierte Läufe pro Buch. Liste kommt ohne result_json (Spaltensparsam);
  // Detail wird beim Öffnen lazy geholt und ins bestehende Vorschlags-Panel
  // (suggestions) gelegt — genau wie ein frischer Lauf, sodass „Übernehmen" greift.
  async loadBrainstormRuns() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId) { this.brainstormRuns = []; return; }
    const isCurrent = loadToken(this, '_brainstormRunsSeq', bookId);
    try {
      const rows = await fetchJson(`/motifs/brainstorm-runs?book_id=${bookId}`);
      if (isCurrent()) this.brainstormRuns = Array.isArray(rows) ? rows : [];
    } catch (e) { if (isCurrent()) this.brainstormRuns = []; }
  },

  // Toggle: Klick auf den aktiven Eintrag schliesst das Panel; sonst Detail laden
  // und suggestions füllen. Während eines Live-Laufs gesperrt.
  async openBrainstormRun(run) {
    if (!run || this.brainstorming) return;
    if (this.selectedBrainstormRunId === run.id) { this._clearSuggestionPanel(); return; }
    const bookId = this.$store.nav.selectedBookId;
    try {
      const detail = await fetchJson(`/motifs/brainstorm-runs/${run.id}`);
      if (!isSelectedBook(bookId)) return;
      if (!detail?.result) throw new Error('no result');
      this.suggestions = detail.result.vorschlaege || [];
      this.selectedBrainstormRunId = detail.id;
      this._scrollToSuggestions();
    } catch (e) {
      this.errorMessage = window.__app.t('motiv.error.runLoad');
    }
  },

  // Zum Vorschlags-Panel scrollen (steht unten beim Verlauf). Geteilt von frischem
  // Lauf + Reopen, damit der geöffnete Lauf sichtbar wird, ohne den Graphen zu decken.
  _scrollToSuggestions() {
    this.$nextTick(() => this.$root?.querySelector('.motiv-suggestions')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  },

  async deleteBrainstormRun(runId) {
    if (!runId) return;
    if (!await window.__app.appConfirm({ message: window.__app.t('motiv.brainstorm.confirmDeleteRun'), danger: true })) return;
    try {
      await fetchJson(`/motifs/brainstorm-runs/${runId}`, { method: 'DELETE' });
      this.brainstormRuns = this.brainstormRuns.filter(r => r.id !== runId);
      if (this.selectedBrainstormRunId === runId) this._clearSuggestionPanel();
    } catch (e) {
      this.errorMessage = window.__app.t('motiv.error.runDelete');
    }
  },

  formatRunDate(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      return d.toLocaleString(localeTag(this.$store.shell?.uiLocale), tzOpts());
    } catch { return iso; }
  },
};
