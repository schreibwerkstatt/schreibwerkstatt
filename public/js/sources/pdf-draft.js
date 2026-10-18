// Quelle aus PDF: der Autor waehlt ein PDF, der Job `source-pdf-draft` bestimmt
// das Werk (DOI → Crossref, ISBN → OpenLibrary, sonst Titelseite lesen →
// Register-Suche) und liefert einen Entwurf. Die Karte oeffnet damit das
// Anlage-Formular; erst „Speichern" legt die Quelle an (POST /sources) und
// haengt das PDF an (POST /sources/:id/doc) — dieselben zwei Endpunkte wie von
// Hand, kein zweiter Schreibpfad. Wird in Alpine.data('sourcesCard') gespreadet
// (public/js/cards/sources-card.js).
//
// Das File-Objekt lebt bis zum Speichern in einer Modul-Variable, NICHT im
// reaktiven Karten-State: ein Alpine-Proxy bricht `File.arrayBuffer()` mit
// „Illegal invocation" (s. public/js/upload-pdf.js). Die Karte fuehrt nur den
// Namen (`srcPdfPendingName`) fuer die Anzeige. Ein Reload verliert die Datei —
// darum auch kein Reconnect des Jobs: ohne Datei gaebe es nichts anzuhaengen.

import { fetchJson } from '../utils.js';
import { startPoll } from '../cards/job-helpers.js';
import { checkPdfFile, uploadPdf } from '../upload-pdf.js';
import { draftFromSource } from './fields.js';

const POLL_MS = 1500;

let _pendingPdf = null;

function _bookId() {
  return window.Alpine?.store('nav')?.selectedBookId || null;
}

export const sourcesPdfDraftMethods = {
  pickSourcePdf() {
    if (this.srcPdfBusy) return;
    this.$refs.srcPdfInput?.click();
  },

  async startSourceFromPdf(evt) {
    const input = evt?.target || null;
    const file = input?.files?.[0];
    const bookId = _bookId();
    if (input) input.value = ''; // sonst ist dieselbe Datei nicht erneut waehlbar
    if (!file || !bookId || this.srcPdfBusy) return;
    const app = window.__app;
    this.srcPdfError = '';
    const bad = checkPdfFile(file);
    if (bad) { this.srcPdfError = bad; return; }

    this.closeSourcePicker();
    this.closeSourceDetect();
    this.closeSourceExport();
    this.closeSourceImport();
    this.cancelSourceEdit();
    this.srcPdfBusy = true;
    this.srcPdfProgress = 0;
    this.srcPdfStatus = app.t('sources.pdfDraft.uploading');
    try {
      const { jobId } = await uploadPdf(`/jobs/source-pdf-draft?book_id=${encodeURIComponent(bookId)}`, file);
      this._pollSourcePdf(jobId, file);
    } catch (e) {
      this._srcPdfIdle();
      this.srcPdfError = e.message;
    }
  },

  _pollSourcePdf(jobId, file) {
    const app = window.__app;
    startPoll(this, {
      timerProp: '_srcPdfPollTimer',
      jobId,
      intervalMs: POLL_MS,
      progressProp: 'srcPdfProgress',
      onProgress: (job) => {
        if (job.statusText) this.srcPdfStatus = app.t(job.statusText, job.statusParams);
      },
      onDone: (job) => {
        this._srcPdfIdle();
        const r = job.result || {};
        this.startCreateSource();
        this.srcDraft = draftFromSource(r.draft || null);
        _pendingPdf = file;
        this.srcPdfPendingName = r.doc_name || file.name || app.t('sources.doc.fallbackName');
        this.srcPdfInfo = {
          method: r.method || null,
          verified: !!r.verified,
          register: r.register || null,
          existing_source_id: r.existing_source_id ?? null,
          existing_linked: !!r.existing_linked,
          existing_has_doc: !!r.existing_has_doc,
          register_skipped: !!r.register_skipped,
          url_from_print: !!r.url_from_print,
          accessed: !!r.draft?.accessed_at,
        };
      },
      onError: (job) => {
        this._srcPdfIdle();
        this.srcPdfError = app.t(job.error, job.errorParams);
      },
      onNotFound: () => {
        this._srcPdfIdle();
        this.srcPdfError = app.t('sources.pdfDraft.interrupted');
      },
    });
  },

  _srcPdfIdle() {
    this.srcPdfBusy = false;
    this.srcPdfProgress = 0;
    this.srcPdfStatus = '';
  },

  /** Herkunft des Entwurfs als Satz ueber dem Formular. */
  srcPdfInfoText() {
    const info = this.srcPdfInfo;
    if (!info) return '';
    const t = window.__app.t;
    if (info.register_skipped) return t('sources.pdfDraft.via.newspaper');
    if (!info.verified) return t('sources.pdfDraft.unverified');
    const register = t(`sources.pdfDraft.register.${info.register || 'crossref'}`);
    return t(`sources.pdfDraft.via.${info.method}`, { register });
  },

  /** Zweite Zeile: woher die Adresse kommt (nur beim gedruckten Web-Artikel). */
  srcPdfUrlText() {
    const info = this.srcPdfInfo;
    if (!info?.url_from_print) return '';
    return window.__app.t(info.accessed ? 'sources.pdfDraft.urlFromPrint' : 'sources.pdfDraft.urlFromPrintNoDate');
  },

  /** Gewaehltes PDF verwerfen — der Entwurf bleibt, nur ohne Anhang. */
  discardPendingPdf() {
    _pendingPdf = null;
    this.srcPdfPendingName = '';
  },

  _clearPdfDraft() {
    _pendingPdf = null;
    this.srcPdfPendingName = '';
    this.srcPdfInfo = null;
  },

  /** Nach dem Anlegen: das gemerkte PDF an die neue Quelle haengen. Die Quelle
   *  steht dann schon — ein Fehlschlag hier darf das Speichern nicht
   *  zuruecknehmen, er wird gemeldet, und das PDF laesst sich im Formular von
   *  Hand nachreichen. */
  async _attachPendingPdf(sourceId) {
    const file = _pendingPdf;
    if (!file || !sourceId) return;
    try {
      await uploadPdf(`/sources/${sourceId}/doc`, file);
      _pendingPdf = null;
    } catch (e) {
      this.sourcesError = window.__app.t('sources.pdfDraft.attachFailed', { error: e.message });
    }
  },

  /** Das Werk liegt schon in der Bibliothek: statt einer Dublette die
   *  vorhandene Quelle nehmen — diesem Buch zuordnen, das PDF anhaengen, wenn
   *  sie noch keines hat, und sie zum Pruefen im Formular oeffnen. */
  async useExistingSourceForPdf() {
    const info = this.srcPdfInfo;
    const bookId = _bookId();
    if (!info?.existing_source_id || !bookId || this.sourcesBusy) return;
    const id = info.existing_source_id;
    const app = window.__app;
    this.sourcesBusy = true;
    this.srcFormError = '';
    try {
      if (!info.existing_linked) {
        await fetchJson(`/sources/${id}/link`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ book_id: Number(bookId) }),
        });
      }
      const attach = !info.existing_has_doc && _pendingPdf;
      if (attach) await this._attachPendingPdf(id);
      this.cancelSourceEdit();
      await this.loadSources();
      this._sourcesChanged();
      const src = this.sources.find(s => s.id === id);
      if (src) this.startEditSource(src);
      this.sourcesNotice = app.t(attach ? 'sources.pdfDraft.usedExistingAttached' : 'sources.pdfDraft.usedExisting');
      this._flashSourcesNotice();
    } catch (e) {
      this.srcFormError = app.tError(e.body || {}) || e.message;
    } finally {
      this.sourcesBusy = false;
    }
  },
};
