// Auto-Erledigt-Check der Ideen im Frontend (Server: routes/jobs/ideen-auto-check.js,
// docs/ideen-board.md «Erledigt-Check nach dem Speichern»).
//
// Der Server legt an einer offenen Idee einen Hinweis ab (`idee.check_hint`:
// geprüftes Zitat, das die Pendenz einlöst). Hier: Hinweis verwerfen («noch
// offen») und in der Ideen-Karte den Check von Hand anstossen. Abhaken läuft
// über die gewöhnliche Stufen-Methode (setIdeeStatus) — der Server räumt den
// Hinweis beim Stufenwechsel selbst ab.
//
// Gespreadet in ideenCard (book/ideen.js-Kontext) und ideenBoardCard; beide
// bringen `ideen`, `busy`, `errorMessage` und `_replaceIdee` mit.

import { fetchJson } from '../utils.js';
import { tFetchError } from '../i18n.js';
import { startPoll } from '../cards/job-helpers.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export function ideenCheckState() {
  return { ideenCheckRunning: false, ideenCheckResult: '', _ideenCheckPollTimer: null };
}

export const ideenCheckMethods = {
  /** Offene Ideen dieser Liste mit Auto-Check-Hinweis. */
  ideenWithCheckHint() {
    return (this.ideen || []).filter(i => i.check_hint);
  },

  async dismissCheckHint(idee) {
    if (!idee || this.busy) return;
    this.busy = true;
    try {
      const row = await fetchJson(`/ideen/${idee.id}/check-hint`, { method: 'DELETE' });
      this._replaceIdee(row);
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = tFetchError(e);
    } finally {
      this.busy = false;
    }
  },

  // Persönlicher Schalter (Board, Stufen-Menü). PATCH /me/settings — gilt für
  // alle Bücher dieses Kontos.
  async toggleAutoCheck() {
    if (this.busy) return;
    const next = !this.autoCheckOn;
    this.busy = true;
    try {
      const data = await fetchJson('/me/settings', {
        method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ ideen_auto_check: next }),
      });
      this.autoCheckOn = data?.ideen_auto_check !== false;
      this.errorMessage = '';
    } catch (e) {
      this.errorMessage = tFetchError(e);
    } finally {
      this.busy = false;
    }
  },

  // Nur in der Abschnitts-Ansicht der Ideen-Karte: der Check prüft die
  // Pendenzen, die direkt an einem Abschnitt hängen.
  async runIdeenCheck() {
    const app = window.__app;
    const pageId = app.currentPage?.id;
    if (!pageId || this.ideenCheckRunning) return;
    this.ideenCheckRunning = true;
    this.ideenCheckResult = '';
    try {
      const { jobId } = await fetchJson('/jobs/ideen-auto-check', {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ page_id: pageId }),
      });
      startPoll(this, {
        timerProp: '_ideenCheckPollTimer',
        jobId,
        onDone: async (job) => {
          this.ideenCheckRunning = false;
          const n = job.result?.hints || 0;
          this.ideenCheckResult = n ? app.tn('ideen.check.found', n) : app.t('ideen.check.none');
          if (app.currentPage?.id === pageId) await this.loadIdeen();
        },
        onNotFound: () => { this.ideenCheckRunning = false; },
        onError: (job) => {
          this.ideenCheckRunning = false;
          this.errorMessage = app.t(job.error || 'ideen.check.error', job.errorParams);
        },
      });
    } catch (e) {
      this.ideenCheckRunning = false;
      this.errorMessage = tFetchError(e);
    }
  },
};
