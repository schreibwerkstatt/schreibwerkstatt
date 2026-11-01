// Serien-Lektorat (Job `batch-check`): ganzes Buch oder ein Kapitel samt
// Unterkapiteln. Methoden der Alpine-Root-Komponente, über lektoratMethods
// (editor/lektorat.js) gespreadet; `this` ist die Root-Komponente.

import { escHtml, fetchJson } from '../../utils.js';
import { lsSet } from '../../safe-storage.js';

export const lektoratBatchMethods = {
  // Serien-Lektorat: ganzes Buch oder — mit `chapterId` — ein Kapitel samt
  // Unterkapiteln. Gleicher Job (`batch-check`), gleiche Statuszeile.
  async batchCheck(chapterId = null) {
    if (!this.$store.nav.pages.length) return;
    const chapter = chapterId != null ? this._findTreeChapter(chapterId) : null;
    if (chapterId != null && !chapter) return;
    // Ganzer Unterbaum aus dem echten Baum — wie der Server (routes/jobs/lektorat.js),
    // unabhaengig von einer laufenden Sidebar-Suche.
    const ids = chapter ? this._chapterSubtreePageIds(chapter) : this.$store.nav.pages.map(p => p.id);
    const all = ids.length;
    if (!all) return;
    // Final markierte, seither unveraenderte Abschnitte prueft der Server nicht
    // (skip_final, docs/bearbeitungsstand.md) — die Rueckfrage nennt beide Zahlen.
    const skipped = this.doneUnchangedCount(ids);
    const n = all - skipped;
    if (n === 0) { this.batchStatus = escHtml(this.t('lektorat.batchAllFinal', { n: skipped })); return; }
    let message = chapter
      ? this.t('lektorat.batchConfirmChapter', { n, name: chapter.name })
      : this.t('lektorat.batchConfirm', { n });
    if (skipped > 0) message += '\n\n' + this.t('lektorat.batchSkipFinal', { n: skipped });
    if (!await this.appConfirm({ message })) return;
    this.batchLoading = true;
    this.batchProgress = 0;
    this.batchStatus = this._runningJobStatus(this.t('common.starting'), 0, 0);
    try {
      const { jobId } = await fetchJson('/jobs/batch-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: parseInt(this.$store.nav.selectedBookId),
          book_name: this.selectedBookName || null,
          ...(chapter ? { chapter_id: parseInt(chapter.id, 10) } : {}),
          skip_final: true,
        }),
      });
      lsSet('lektorat_batchcheck_job_' + this.$store.nav.selectedBookId, jobId);
      this.startBatchPoll(jobId);
    } catch (e) {
      console.error('[batchCheck]', e);
      this.batchStatus = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(e.message)}</span>`;
      this.batchLoading = false;
    }
  },

  startBatchPoll(jobId) {
    const bookId = this.$store.nav.selectedBookId;
    this._startPoll({
      timerProp: '_batchPollTimer',
      jobId,
      lsKey: 'lektorat_batchcheck_job_' + bookId,
      progressProp: 'batchProgress',
      onProgress: (job) => {
        this.batchStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams);
      },
      onNotFound: () => {
        this.batchLoading = false;
        this.batchStatus = escHtml(this.t('job.interrupted'));
      },
      onError: (job) => {
        this.batchLoading = false;
        setTimeout(() => { this.batchProgress = 0; }, 400);
        this.batchStatus = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(this.t(job.error, job.errorParams))}</span>`;
      },
      onDone: async (job) => {
        this.batchLoading = false;
        setTimeout(() => { this.batchProgress = 0; }, 400);
        if (job.result?.empty) {
          this.batchStatus = escHtml(job.result.skippedFinal > 0
            ? this.t('lektorat.batchAllFinal', { n: job.result.skippedFinal })
            : this.t(job.result.chapterId != null ? 'lektorat.batchNoPagesChapter' : 'lektorat.batchNoPages'));
          return;
        }
        const r = job.result;
        // Leere und gescheiterte Seiten getrennt nennen — „X/Y geprüft" allein
        // lässt offen, ob der Rest leer war oder ein Fehler ihn übersprungen hat.
        // x-html-Sink: Seitennamen escapen.
        let status = escHtml(this.t('lektorat.batchDone', { done: r.done, total: r.pageCount, errors: r.totalErrors }));
        if (r.skippedEmpty > 0) status += ' ' + escHtml(this.t('lektorat.batchSkippedEmpty', { n: r.skippedEmpty }));
        if (r.skippedFinal > 0) status += ' ' + escHtml(this.t('lektorat.batchSkippedFinal', { n: r.skippedFinal }));
        const failed = Array.isArray(r.failed) ? r.failed : [];
        if (failed.length > 0) {
          const MAX_NAMES = 5;
          const names = failed.slice(0, MAX_NAMES).map(p => `«${p.name}»`).join(', ') + (failed.length > MAX_NAMES ? ', …' : '');
          status += ` <span class="error-msg">${escHtml(this.t('lektorat.batchFailed', { n: failed.length, names }))}</span>`;
        }
        this.batchStatus = status;
        this.refreshPageAges();
        if (this.currentPage) await this.loadPageHistory(this.currentPage.id);
      },
    });
  },
};
