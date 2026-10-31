// Fassungs-PDF-Export (aus dem Snapshot-Reader) — ausgelagert aus snapshots-card.js
// (LOC-Split). Wird via `...snapshotsPdfMethods` in snapshotsCard gespreadet und
// laeuft im Karten-Scope (`this` = die Karte). Reine Methoden (keine Getter) —
// siehe Spread-Getter-Falle in der State-Doku.
//
// PDF laeuft ueber die Job-Queue (Render-Dauer + Profil-Auswahl): POST
// /jobs/pdf-export mit `snapshot_id` → Polling via startPoll → Download-Stream.
// Der Job baut das Bundle aus dem selbsttragenden Fassungs-Stand (snapshotToBundle)
// und nutzt die eingefrorene publication_json der Fassung.

import { fetchJson, downloadHref } from '../utils.js';
import { startPoll } from './job-helpers.js';

export const snapshotsPdfMethods = {
  async loadPdfProfiles() {
    try {
      const d = await fetchJson('/pdf-export/profiles');
      this.pdfProfiles = Array.isArray(d?.profiles) ? d.profiles : [];
      const def = this.pdfProfiles.find(p => p.is_default) || this.pdfProfiles[0] || null;
      if (def && (!this.pdfProfileId || !this.pdfProfiles.some(p => String(p.id) === String(this.pdfProfileId)))) {
        this.pdfProfileId = String(def.id);
      }
    } catch (e) {
      console.error('[snapshots:pdfProfiles]', e);
      this.pdfProfiles = [];
    }
  },

  pdfProfileOptions() {
    return this.pdfProfiles.map(p => ({ value: String(p.id), label: p.name }));
  },

  async exportPdf() {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.readerSnap?.id || !this.pdfProfileId || this.pdfExporting) return;
    this.pdfExporting = true;
    this.pdfError = '';
    this.pdfStatus = app.t('snapshots.export.creating');
    try {
      const r = await fetch('/jobs/pdf-export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'book',
          entityId: parseInt(bookId, 10),
          profile_id: parseInt(this.pdfProfileId, 10),
          snapshot_id: this.readerSnap.id,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.error_code || `HTTP ${r.status}`);
      }
      const { jobId } = await r.json();
      this.pdfJobId = jobId;
      this._startPdfPoll(jobId);
    } catch (e) {
      console.error('[snapshots:exportPdf]', e);
      this.pdfExporting = false;
      this.pdfError = app.t('snapshots.export.pdfFailed') + ' ' + (e.message || '');
      this.pdfStatus = '';
    }
  },

  _startPdfPoll(jobId) {
    this._stopPdfPoll();
    startPoll(this, {
      timerProp: '_pdfPollTimer',
      jobId,
      intervalMs: 1000,
      onProgress: (job) => {
        const app = window.__app;
        this.pdfStatus = job.statusText ? app.t(job.statusText, job.statusParams) : app.t('snapshots.export.creating');
      },
      onError: (job) => {
        const app = window.__app;
        this.pdfExporting = false;
        this.pdfStatus = '';
        this.pdfError = app.t('snapshots.export.pdfFailed') + ' ' + (job.error ? app.t(job.error, job.errorParams) : '');
      },
      onDone: (job) => {
        const app = window.__app;
        this.pdfExporting = false;
        this.pdfStatus = app.t('snapshots.export.pdfDone');
        this._triggerPdfDownload(jobId, job.result?.filename);
        setTimeout(() => { this.pdfStatus = ''; }, 3500);
      },
    });
  },

  _stopPdfPoll() {
    if (this._pdfPollTimer) { clearInterval(this._pdfPollTimer); this._pdfPollTimer = null; }
  },

  _triggerPdfDownload(jobId, filename) {
    downloadHref(`/jobs/pdf-export/${jobId}/file`, filename || 'fassung.pdf');
  },

  _resetPdfExport() {
    this.pdfExporting = false;
    this.pdfStatus = '';
    this.pdfError = '';
    this.pdfJobId = null;
  },
};
