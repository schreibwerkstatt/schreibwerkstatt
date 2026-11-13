// Exposé-Reiter der Bucheinstellungen (docs/expose.md). Gespreadet in
// Alpine.data('bookSettingsCard'), Root-Zugriffe via window.__app.
//
// Gespeichert wird hier NUR, was der Job neu erzeugt (Logline, Kurzinhalt …)
// und die Autorfassung davon (PATCH /expose/:book/:id). Die Eckdaten zeigt der
// Reiter live aus dem Formular der Karte (Titel, Buchtyp, Publikation); der
// Klappentext ist das Feld bookPublication.description selbst — „übernehmen"
// setzt nur dieses Feld, gespeichert wird es wie alles andere über den
// Speichern-Knopf der Karte.

import { fetchJson, sendJson, EVT } from './_shared.js';
import { exposeProfil } from '../../prompts.js';
import { fmtDateTime } from '../../utils.js';
import { tFetchError } from '../../i18n.js';

const _clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

export const exposeMethods = {
  exposeProfilActive() {
    return exposeProfil(this.bookSettingsBuchtyp || null);
  },

  // `keepDraft`: offene Autorfassung nicht ersetzen — nur Historie und
  // Normseiten auffrischen (ein neuer Lauf landet dann in der Historie).
  async loadExpose(bookId = this._selectedBookId(), { keepDraft = false } = {}) {
    if (!bookId) return;
    try {
      const data = await fetchJson(`/expose/${bookId}`);
      if (!this._isFormBook(bookId)) return;
      this.exposeHistory = data.history || [];
      this.exposeNormseiten = data.normseiten || 0;
      if (!keepDraft) this._setExposeRun(data.latest || null);
      this.exposeLoaded = true;
    } catch (e) {
      // 403 für Rollen unter editor: der Reiter bleibt leer, kein Fehlerbanner.
      if (e?.status !== 403 && this._isFormBook(bookId)) this.exposeError = tFetchError(e);
    }
  },

  _setExposeRun(run) {
    this.exposeRun = run;
    this.exposeDraft = run ? _clone(run.edited || run.result) : null;
    this.exposeDirty = false;
  },

  async openExposeRun(id) {
    const bookId = this._formBookId;
    if (!bookId || (this.exposeRun?.id === id)) return;
    if (this.exposeDirty && !await window.__app.appConfirm({ message: window.__app.t('expose.discardEdits'), danger: true })) return;
    try {
      const run = await fetchJson(`/expose/${bookId}/${id}`);
      if (!this._isFormBook(bookId)) return;
      this._setExposeRun(run);
    } catch (e) {
      if (this._isFormBook(bookId)) this.exposeError = tFetchError(e);
    }
  },

  async generateExpose() {
    const bookId = this._formBookId;
    if (!bookId || this.exposeGenerating) return;
    this.exposeGenerating = true;
    this.exposeError = '';
    try {
      const data = await sendJson('/jobs/expose', 'POST', { book_id: Number(bookId) });
      this.exposeJobId = data.jobId;
      window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, { detail: { type: 'expose', jobId: data.jobId } }));
    } catch (e) {
      this.exposeGenerating = false;
      this.exposeError = tFetchError(e);
    }
  },

  // job:finished (Handler in der Karte). Nur Läufe des Buchs im Formular.
  async onExposeJobFinished(detail) {
    const bookId = detail?.bookId;
    if (!this._isFormBook(bookId)) return;
    const job = detail.job;
    this.exposeGenerating = false;
    this.exposeJobId = null;
    if (job?.status === 'error') {
      this.exposeError = window.__app.t(job.error || 'common.unknownError', job.errorParams || {});
      return;
    }
    if (job?.status !== 'done') return;
    if (job.result?.empty) { this.exposeError = window.__app.t('expose.empty'); return; }
    // Ungespeicherte Autorfassung nicht überfahren: ein neuer Lauf öffnet sich
    // nur, wenn nichts offen ist — sonst landet er in der Historie.
    const keepDraft = this.exposeDirty && !!this.exposeRun;
    await this.loadExpose(bookId, { keepDraft });
    if (keepDraft) this.exposeError = window.__app.t('expose.newRunBehindEdits');
    this.exposeUnchanged = !!job.result?.unchanged;
  },

  markExposeDirty() {
    this.exposeDirty = true;
    this.exposeSaved = false;
  },

  // Über den Kopf-Knopf der Karte mitgespeichert (save-paths.js).
  async saveExpose(bookId = this._formBookId) {
    if (!bookId || !this.exposeDirty || !this.exposeRun) return true;
    this.exposeSaving = true;
    this.exposeSaved = false;
    this.exposeError = '';
    const sent = JSON.stringify(this.exposeDraft);
    try {
      const data = await sendJson(`/expose/${bookId}/${this.exposeRun.id}`, 'PATCH', { edited: this.exposeDraft });
      if (this._isFormBook(bookId)) {
        // Während des Speicherns weitergetippt → Entwurf behalten, bleibt ungespeichert.
        if (JSON.stringify(this.exposeDraft) === sent) this._setExposeRun(data);
        else this.exposeRun = data;
        this.exposeHistory = this.exposeHistory.map(h => (h.id === data.id ? { ...h, has_edits: !!data.edited } : h));
      }
      this.exposeSaved = true;
      this._flash('exposeSaved');
      return true;
    } catch (e) {
      this.exposeError = tFetchError(e);
      return false;
    } finally {
      this.exposeSaving = false;
    }
  },

  async resetExposeToKi() {
    const bookId = this._formBookId;
    if (!bookId || !this.exposeRun) return;
    if (!await window.__app.appConfirm({ message: window.__app.t('expose.resetConfirm'), confirmLabel: window.__app.t('expose.resetToKi'), danger: true })) return;
    try {
      const data = await sendJson(`/expose/${bookId}/${this.exposeRun.id}`, 'PATCH', { edited: null });
      if (!this._isFormBook(bookId)) return;
      this._setExposeRun(data);
      this.exposeHistory = this.exposeHistory.map(h => (h.id === data.id ? { ...h, has_edits: false } : h));
    } catch (e) {
      this.exposeError = tFetchError(e);
    }
  },

  async deleteExposeRun(id) {
    const bookId = this._formBookId;
    if (!bookId || !await window.__app.appConfirm({ message: window.__app.t('expose.deleteConfirm'), confirmLabel: window.__app.t('expose.history.delete'), danger: true })) return;
    try {
      await sendJson(`/expose/${bookId}/${id}`, 'DELETE');
      if (!this._isFormBook(bookId)) return;
      if (this.exposeRun?.id === id) this._setExposeRun(null);
      await this.loadExpose(bookId);
    } catch (e) {
      this.exposeError = tFetchError(e);
    }
  },

  // Klappentext-Vorschlag ins Publikationsfeld (gespeichert über „Speichern").
  async adoptExposeKlappentext() {
    const text = (this.exposeDraft?.klappentext || '').trim();
    if (!text || !this.bookPublicationLoaded) return;
    const cur = (this.bookPublication.description || '').trim();
    if (cur && cur !== text && !await window.__app.appConfirm({ message: window.__app.t('expose.adoptConfirm'), confirmLabel: window.__app.t('expose.klappentext.adopt') })) return;
    this.bookPublication.description = text;
    this.exposeAdopted = true;
  },

  exposeKlappentextIsAdopted() {
    const t = (this.exposeDraft?.klappentext || '').trim();
    return !!t && t === (this.bookPublication?.description || '').trim();
  },

  // Eckdaten live aus dem Formular der Karte — nichts davon liegt im Exposé.
  exposeGenreLabel() {
    const t = this.bookSettingsBuchtypen().find(x => x.key === this.bookSettingsBuchtyp);
    return t?.label || '';
  },

  exposePovLabel() {
    return this.bookSettingsPovOptions().find(o => o.value === this.bookSettingsErzaehlperspektive)?.label || '';
  },

  exposeTempusLabel() {
    return this.bookSettingsTempusOptions().find(o => o.value === this.bookSettingsErzaehlzeit)?.label || '';
  },

  exposeWhen(ts) {
    return fmtDateTime(ts, Alpine.store('shell').uiLocale);
  },

  exposeRunLabel(h) {
    const when = this.exposeWhen(h.created_at);
    return h.has_edits ? `${when} · ${window.__app.t('expose.history.edited')}` : when;
  },

  // Word-Download des angezeigten Laufs (Autorfassung vor KI-Fassung; offene
  // Änderungen erst speichern — der Server kennt nur den gespeicherten Stand).
  exposeDocxUrl() {
    const bookId = this._formBookId;
    return bookId && this.exposeRun ? `/expose/${bookId}/${this.exposeRun.id}/docx` : null;
  },

  exposeWarnText(w) {
    return window.__app.t(w.key, w.params || {});
  },
};
