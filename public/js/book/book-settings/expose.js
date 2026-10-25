// Exposé-Reiter der Bucheinstellungen (docs/expose.md). Gespreadet in
// Alpine.data('bookSettingsCard'), Root-Zugriffe via window.__app.
//
// Gespeichert wird hier NUR, was der Job neu erzeugt (Logline, Kurzinhalt …)
// und die Autorfassung davon (PATCH /expose/:book/:id). Die Eckdaten zeigt der
// Reiter live aus dem Formular der Karte (Titel, Buchtyp, Publikation); der
// Klappentext ist das Feld bookPublication.description selbst — „übernehmen"
// setzt nur dieses Feld, gespeichert wird es wie alles andere über den
// Speichern-Knopf der Karte.

import { fetchJson, EVT } from './_shared.js';
import { exposeProfil } from '../../prompts.js';
import { tzOpts, localeTag } from '../../utils.js';
import { tFetchErrorRaw } from '../../i18n.js';

const _clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

export const exposeMethods = {
  exposeProfilActive() {
    return exposeProfil(this.bookSettingsBuchtyp || null);
  },

  async loadExpose() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    try {
      const data = await fetchJson(`/expose/${bookId}`);
      this.exposeHistory = data.history || [];
      this.exposeNormseiten = data.normseiten || 0;
      this._setExposeRun(data.latest || null);
      this.exposeLoaded = true;
    } catch (e) {
      // 403 für Rollen unter editor: der Reiter bleibt leer, kein Fehlerbanner.
      if (e?.status !== 403) this.exposeError = tFetchErrorRaw(e);
    }
  },

  _setExposeRun(run) {
    this.exposeRun = run;
    this.exposeDraft = run ? _clone(run.edited || run.result) : null;
    this.exposeDirty = false;
  },

  async openExposeRun(id) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || (this.exposeRun?.id === id)) return;
    if (this.exposeDirty && !await window.__app.appConfirm({ message: window.__app.t('expose.discardEdits'), danger: true })) return;
    try {
      this._setExposeRun(await fetchJson(`/expose/${bookId}/${id}`));
    } catch (e) {
      this.exposeError = tFetchErrorRaw(e);
    }
  },

  async generateExpose() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.exposeGenerating) return;
    this.exposeGenerating = true;
    this.exposeError = '';
    try {
      const res = await fetch('/jobs/expose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: Number(bookId) }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(window.__app.tError(data) || `HTTP ${res.status}`);
      this.exposeJobId = data.jobId;
      window.dispatchEvent(new CustomEvent(EVT.JOB_ENQUEUED, { detail: { type: 'expose', jobId: data.jobId } }));
    } catch (e) {
      this.exposeGenerating = false;
      this.exposeError = e.message;
    }
  },

  // job:finished (Handler in der Karte).
  async onExposeJobFinished(job) {
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
    const keepDraft = this.exposeDirty;
    const run = this.exposeRun;
    await this.loadExpose();
    if (keepDraft && run) {
      this.exposeError = window.__app.t('expose.newRunBehindEdits');
    }
    this.exposeUnchanged = !!job.result?.unchanged;
  },

  markExposeDirty() {
    this.exposeDirty = true;
    this.exposeSaved = false;
  },

  // Über saveActiveTab (Speichern-Knopf der Karte) mitgespeichert.
  async saveExpose() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.exposeDirty || !this.exposeRun) return;
    this.exposeSaving = true;
    this.exposeError = '';
    try {
      const res = await fetch(`/expose/${bookId}/${this.exposeRun.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edited: this.exposeDraft }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(window.__app.tError(data) || `HTTP ${res.status}`);
      this._setExposeRun(data);
      this.exposeHistory = this.exposeHistory.map(h => (h.id === data.id ? { ...h, has_edits: !!data.edited } : h));
      this.exposeSaved = true;
      if (this._exposeSavedTimer) clearTimeout(this._exposeSavedTimer);
      this._exposeSavedTimer = setTimeout(() => { this.exposeSaved = false; this._exposeSavedTimer = null; }, 2500);
    } catch (e) {
      this.exposeError = e.message;
    } finally {
      this.exposeSaving = false;
    }
  },

  async resetExposeToKi() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.exposeRun) return;
    if (!await window.__app.appConfirm({ message: window.__app.t('expose.resetConfirm'), confirmLabel: window.__app.t('expose.resetToKi'), danger: true })) return;
    try {
      const res = await fetch(`/expose/${bookId}/${this.exposeRun.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edited: null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(window.__app.tError(data) || `HTTP ${res.status}`);
      this._setExposeRun(data);
      this.exposeHistory = this.exposeHistory.map(h => (h.id === data.id ? { ...h, has_edits: false } : h));
    } catch (e) {
      this.exposeError = e.message;
    }
  },

  async deleteExposeRun(id) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !await window.__app.appConfirm({ message: window.__app.t('expose.deleteConfirm'), confirmLabel: window.__app.t('expose.history.delete'), danger: true })) return;
    try {
      const res = await fetch(`/expose/${bookId}/${id}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(window.__app.tError(d) || `HTTP ${res.status}`); }
      if (this.exposeRun?.id === id) this._setExposeRun(null);
      await this.loadExpose();
    } catch (e) {
      this.exposeError = e.message;
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
    if (!ts) return '';
    const d = new Date(ts);
    return isNaN(d) ? ts : d.toLocaleString(localeTag(Alpine.store('shell').uiLocale), tzOpts({ dateStyle: 'medium', timeStyle: 'short' }));
  },

  exposeRunLabel(h) {
    const when = this.exposeWhen(h.created_at);
    return h.has_edits ? `${when} · ${window.__app.t('expose.history.edited')}` : when;
  },

  // Word-Download des angezeigten Laufs (Autorfassung vor KI-Fassung; offene
  // Änderungen erst speichern — der Server kennt nur den gespeicherten Stand).
  exposeDocxUrl() {
    const bookId = Alpine.store('nav').selectedBookId;
    return bookId && this.exposeRun ? `/expose/${bookId}/${this.exposeRun.id}/docx` : null;
  },

  exposeWarnText(w) {
    return window.__app.t(w.key, w.params || {});
  },
};
