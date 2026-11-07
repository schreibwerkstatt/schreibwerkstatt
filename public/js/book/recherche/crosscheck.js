// Recherche-Abgleich der Recherche-Karte: Manuskript gegen gesammelte Fakten und
// Zitate pruefen (Job /jobs/research-crosscheck) und die Befunde am Fundstueck
// zeigen (`item.findings`, aus research_item_findings). Rueckwaertsgewandt: ein
// Befund ist ein Hinweis mit Sprung zur Stelle, keine Korrektur.

import { fetchJson } from '../../utils.js';
import { startPoll } from '../../cards/job-helpers.js';

export function rechercheCrosscheckState() {
  return {
    crosscheckRunning: false,
    // Fundstueck-Id eines Einzel-Abgleichs (Detail-Dialog), null = ganzes Board.
    crosscheckItemId: null,
    crosscheckStatus: '',
    _crosscheckTimer: null,
  };
}

export const rechercheCrosscheckMethods = {
  async runCrosscheck(item = null) {
    const app = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.crosscheckRunning) return;
    this.crosscheckRunning = true;
    this.crosscheckItemId = item?.id ?? null;
    this.crosscheckStatus = app.t('recherche.crosscheck.running');
    const stop = () => { this.crosscheckRunning = false; this.crosscheckItemId = null; };
    try {
      const { jobId } = await fetchJson('/jobs/research-crosscheck', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, ...(item ? { item_id: item.id } : {}) }),
      });
      startPoll(this, {
        timerProp: '_crosscheckTimer',
        jobId,
        onProgress: (job) => { if (job.statusText) this.crosscheckStatus = app.t(job.statusText, job.statusParams || {}); },
        onNotFound: () => { stop(); this.crosscheckStatus = ''; },
        onError: () => {
          stop();
          this.crosscheckStatus = '';
          this.errorMessage = app.t('recherche.crosscheck.error');
        },
        onDone: async (job) => {
          stop();
          const r = job.result || {};
          const main = r.checked
            ? app.tn(r.findings ? 'recherche.crosscheck.doneFindings' : 'recherche.crosscheck.doneClean', r.checked, { findings: r.findings || 0, unchecked: r.unchecked || 0 })
            : (r.failed ? '' : app.t('recherche.crosscheck.nothing'));
          // `failed` (in `unchecked` enthalten): wegen Fehler ungeprueft — eigener
          // Hinweis, weil deren alte Befunde stehen bleiben und veraltet sein koennen.
          const failed = r.failed ? app.tn('recherche.crosscheck.failed', r.failed) : '';
          this.crosscheckStatus = [main, failed].filter(Boolean).join(' ');
          await this.loadRecherche();
        },
      });
    } catch {
      stop();
      this.crosscheckStatus = '';
      this.errorMessage = app.t('recherche.crosscheck.error');
    }
  },
  itemFindings(item) { return item?.findings || []; },
  findingTypeLabel(f) { return window.__app.t(`recherche.crosscheck.typ.${f.typ}`); },
  gotoFinding(f) { this.gotoLink({ target_kind: 'page', target_id: f.page_id }); },
  canCrosscheck(item) { return item?.kind === 'fact' || item?.kind === 'quote'; },
};
