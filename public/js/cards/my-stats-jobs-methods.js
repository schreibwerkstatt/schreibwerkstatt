// Kachel «KI-Jobs» in «Meine Statistik» (partials/my-stats-jobs.html): eigene
// Läufe je Job-Typ (Dauer, Tokens, Fehler) über alle Bücher oder ein gewähltes,
// Drill-Down auf die letzten Läufe eines Typs. Gespreadet in
// Alpine.data('myStatsCard'). Daten: GET /jobs/stats, GET /jobs/runs — beide
// filtern serverseitig auf die Läufe des angemeldeten Users.

import { fetchJson } from '../utils.js';

export const myStatsJobsState = () => ({
  // '' = alle Bücher, sonst Buch-ID als String.
  myJobsBookId: '',
  myJobStats: null,
  myJobStatsLoading: false,
  myJobsExpandedType: null,
  // Läufe je Typ für den aktuellen Buchfilter (Cache bis zum Filterwechsel).
  myJobRuns: {},
  myJobRunsLoading: false,
});

export const myStatsJobsMethods = {
  _myJobsQuery() {
    return this.myJobsBookId ? `book_id=${encodeURIComponent(this.myJobsBookId)}` : '';
  },

  async loadMyJobStats() {
    const filter = this.myJobsBookId;
    this.myJobStatsLoading = true;
    this.myJobsExpandedType = null;
    this.myJobRuns = {};
    try {
      const q = this._myJobsQuery();
      const rows = await fetchJson(`/jobs/stats${q ? '?' + q : ''}`);
      if (filter !== this.myJobsBookId) return;
      this.myJobStats = rows;
    } catch (e) {
      console.error('[myStats] Job-Statistiken laden fehlgeschlagen:', e);
      if (filter === this.myJobsBookId) this.myJobStats = [];
    } finally {
      if (filter === this.myJobsBookId) this.myJobStatsLoading = false;
    }
  },

  _myJobsBookName(bookId) {
    return (Alpine.store('nav').books || []).find(b => String(b.id) === String(bookId))?.name || '';
  },

  // Zeilen der sortierbaren Tabelle. Der Server liefert `typeLabel` als
  // i18n-Key und die Zahlenspalten zusätzlich vorformatiert; sortiert wird nach
  // dem, was der User SIEHT (übersetztes Label) bzw. nach dem Rohwert.
  myJobStatsRows() {
    return (this.myJobStats || []).map(r => ({
      ...r,
      typeName:  window.__app.t(r.typeLabel),
      avgTokens: r.avgTokensIn != null ? (r.avgTokensIn || 0) + (r.avgTokensOut || 0) : null,
    }));
  },

  // Drill-Down: Typ-Zeile aufklappen → letzte 20 Läufe nachladen. Cache pro
  // Typ; erneutes Klicken schliesst nur.
  async toggleMyJobRuns(type) {
    if (this.myJobsExpandedType === type) {
      this.myJobsExpandedType = null;
      return;
    }
    this.myJobsExpandedType = type;
    if (this.myJobRuns[type]) return;
    const filter = this.myJobsBookId;
    this.myJobRunsLoading = true;
    try {
      const q = this._myJobsQuery();
      const runs = await fetchJson(`/jobs/runs?type=${encodeURIComponent(type)}&limit=20${q ? '&' + q : ''}`);
      if (filter !== this.myJobsBookId) return;
      this.myJobRuns = { ...this.myJobRuns, [type]: runs };
    } catch (e) {
      console.error('[myStats] Job-Läufe laden fehlgeschlagen:', e);
      if (filter === this.myJobsBookId) this.myJobRuns = { ...this.myJobRuns, [type]: [] };
    } finally {
      if (filter === this.myJobsBookId) this.myJobRunsLoading = false;
    }
  },
};
