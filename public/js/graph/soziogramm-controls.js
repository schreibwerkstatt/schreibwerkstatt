// Soziogramm-Bedienung der Figuren-Karte: Schalter «Kapitel-Inseln» und
// «Begegnungen», Stand der Nähe-Einschätzung und der Job `figuren-naehe`.
// Gespreadet in figurenCard (State über soziogrammState(), Methoden hier).

import { startPoll } from '../cards/job-helpers.js';
import { tnRaw } from '../i18n.js';

const _t = (k, p) => window.__app.t(k, p);

export const soziogrammState = () => ({
  soziogrammInseln: true,
  soziogrammBegegnungen: false,
  soziogrammNaeheLoading: false,
  soziogrammNaeheProgress: 0,
  soziogrammNaeheStatus: '',
  _soziogrammNaehePollTimer: null,
});

export const soziogrammControlMethods = {
  _resetSoziogramm() {
    clearInterval(this._soziogrammNaehePollTimer);
    Object.assign(this, soziogrammState());
  },

  // Schalter (toggleSwitch, @toggle-change): Wert setzen, neu rechnen.
  setSoziogrammInseln(on) {
    this.soziogrammInseln = !!on;
    this.renderFigurGraph();
  },

  // Begegnungen brauchen den Szenen-Katalog; der lädt nur, wenn er noch fehlt.
  async setSoziogrammBegegnungen(on) {
    this.soziogrammBegegnungen = !!on;
    if (this.soziogrammBegegnungen && !Alpine.store('catalog').szenen?.length) {
      await window.__app.loadSzenen(Alpine.store('nav').selectedBookId);
    }
    this.renderFigurGraph();
  },

  // Beziehungen mit und ohne eingeschätzte Nähe (je Paar einmal gezählt, wie gezeichnet).
  soziogrammNaeheStand() {
    const figuren = Alpine.store('catalog').figuren || [];
    return this._memo('naeheStand', [figuren], () => {
      const ids = new Set(figuren.map(f => String(f.id)));
      let total = 0, offen = 0;
      for (const f of figuren) {
        for (const bz of (f.beziehungen || [])) {
          if (!ids.has(String(bz.figur_id))) continue;
          total++;
          if (bz.naehe == null) offen++;
        }
      }
      return { total, offen };
    });
  },

  async runFigurenNaehe() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.soziogrammNaeheLoading) return;
    const { offen } = this.soziogrammNaeheStand();
    this.soziogrammNaeheLoading = true;
    this.soziogrammNaeheProgress = 0;
    this.soziogrammNaeheStatus = _t('graph.sozio.naeheRunning');
    const finish = (status) => {
      this.soziogrammNaeheLoading = false;
      this.soziogrammNaeheProgress = 0;
      this.soziogrammNaeheStatus = status;
    };
    try {
      const res = await fetch('/jobs/figuren-naehe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Alles offen eingeschätzt → ein erneuter Klick schätzt alle neu ein.
        body: JSON.stringify({ book_id: bookId, alle: offen === 0 }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j?.jobId) throw new Error(window.__app.tError(j) || _t('graph.sozio.naeheError'));
      if (String(Alpine.store('nav').selectedBookId) !== String(bookId)) return;
      startPoll(this, {
        timerProp: '_soziogrammNaehePollTimer',
        jobId: j.jobId,
        progressProp: 'soziogrammNaeheProgress',
        intervalMs: 1200,
        onDone: async (job) => {
          finish(tnRaw('graph.sozio.naeheDone', job?.result?.geschrieben ?? 0));
          await window.__app.loadFiguren(bookId);
        },
        onError: (job) => finish(job?.error ? _t(job.error, job.errorParams) : _t('graph.sozio.naeheError')),
        onNotFound: () => finish(_t('graph.sozio.naeheError')),
      });
    } catch (e) {
      finish(e.message);
    }
  },
};
