// «Nachprüfen» der Kontinuitäts-Karte (gespreadet in Alpine.data('kontinuitaetCard')).
// Ein Job prüft einzelne Befunde am aktuellen Text (routes/jobs/komplett/job-recheck.js);
// «behoben» mit Beleg erledigt den Befund serverseitig, die Karte lädt danach neu.
// `changed` am Issue (Server: Stelle nach Prüflauf/letzter Nachprüfung gespeichert)
// macht die Kandidaten für «Geänderte nachprüfen» sichtbar; `missing_since` die
// «nicht mehr gemeldeten» Befunde früherer Läufe (db/continuity.js#saveContinuityCheck).

import { escHtml, dateTimeFormat } from '../utils.js';
import { startPoll, runningJobStatus } from '../cards/job-helpers.js';
import { isSelectedBook } from '../cards/book-guard.js';

function _isOpen(issue) {
  return !issue.resolved && !issue.dismissed && !issue.discarded;
}

export const kontinuitaetRecheckMethods = {
  /** Offene Befunde, deren Stelle seit dem Prüflauf (bzw. der letzten Nachprüfung) geändert wurde. */
  kontinuitaetChangedIssues() {
    return (this.kontinuitaetResult?.issues || []).filter(i => _isOpen(i) && i.changed);
  },

  /** Offene Befunde früherer Läufe, die der letzte Lauf nicht mehr gemeldet hat. */
  kontinuitaetMissingIssues() {
    return (this.kontinuitaetResult?.issues || []).filter(i => _isOpen(i) && i.missing_since);
  },

  kontinuitaetRecheckMissing() {
    return this._kontinuitaetStartRecheck(this.kontinuitaetMissingIssues().map(i => i.id));
  },

  kontinuitaetMissingSinceText(issue) {
    const iso = issue?.missing_since;
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const date = dateTimeFormat(Alpine.store('shell')?.uiLocale, { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
    return window.__app.t('kontinuitaet.missing.since', { date });
  },

  kontinuitaetIsRechecking(issue) {
    return this.kontinuitaetRecheckIds.includes(issue?.id);
  },

  kontinuitaetRecheck(issue) {
    if (!issue || issue.id == null) return;
    return this._kontinuitaetStartRecheck([issue.id]);
  },

  kontinuitaetRecheckChanged() {
    return this._kontinuitaetStartRecheck(this.kontinuitaetChangedIssues().map(i => i.id));
  },

  kontinuitaetRecheckVerdictText(issue) {
    const v = issue?.recheck?.verdict;
    return v ? window.__app.t('kontinuitaet.recheckVerdict.' + v) : '';
  },

  async _kontinuitaetStartRecheck(ids) {
    const root = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !ids.length || this.kontinuitaetLoading || this.kontinuitaetRecheckIds.length) return;
    this.kontinuitaetRecheckIds = ids.slice();
    this.kontinuitaetStatus = runningJobStatus(root.t, 'kontinuitaet.recheckRunning');
    const finish = (statusHtml = '') => {
      this.kontinuitaetRecheckIds = [];
      this.kontinuitaetStatus = statusHtml;
    };
    const showError = (text) => finish(`<span class="error-msg">${escHtml(text)}</span>`);
    try {
      const resp = await fetch('/jobs/kontinuitaet/recheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, book_name: root.selectedBookName || '', issue_ids: ids }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!isSelectedBook(bookId)) return;
      if (!resp.ok || !data.jobId) {
        if (resp.status === 401) { finish(); return; }
        showError(this._kontinuitaetStartErrorText(data));
        return;
      }
      startPoll(this, {
        jobId: data.jobId,
        timerProp: '_kontinuitaetRecheckTimer',
        onProgress: (job) => {
          this.kontinuitaetStatus = runningJobStatus(
            root.t, job.statusText, job.tokensIn, job.tokensOut,
            Alpine.store('config').claudeMaxTokens, job.progress, job.tokensPerSec, job.statusParams);
        },
        onDone: async (job) => {
          const results = Array.isArray(job?.result?.results) ? job.result.results : [];
          const behoben = results.filter(r => r.resolved).length;
          finish(escHtml(root.t('kontinuitaet.recheckDone', { behoben, total: results.length })));
          await this._loadKontinuitaetHistory();
        },
        onError: async (job) => { showError(this._kontinuitaetJobErrorText(job)); },
        onNotFound: () => { finish(); },
      });
    } catch (e) {
      if (!isSelectedBook(bookId)) return;
      showError(root.t('kontinuitaet.error.startFailed'));
      console.error('[_kontinuitaetStartRecheck]', e);
    }
  },
};
