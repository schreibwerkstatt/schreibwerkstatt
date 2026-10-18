// Motiv-Werkstatt — KI-Motiverkennung (Ist-Index). Stösst den motif-scan-Job an
// und pollt ihn; bei Abschluss den Graph neu laden (Fundstellen → Knotengrösse).

import { fetchJson } from '../../utils.js';
import { startPoll } from '../../cards/job-helpers.js';

export const scanMethods = {
  // Ist die semantische Erkennung aktiv? (Embedding-Backend an — /config).
  // Ist sie aus, findet der Scan nur wörtliche Trigger; das Panel warnt dann.
  semanticActive() {
    return !!this.$store.config?.semanticSearchEnabled;
  },

  // Embedding-Index des Buches aktualisieren, damit der semantische Scan frische
  // Vektoren sieht (neu geschriebener Text). Nach Abschluss automatisch rescannen.
  // Lief schon ein Index-Lauf, meldet der Server `rerunQueued`: der laufende Lauf
  // sieht die jüngsten Änderungen nicht, ein Folgelauf ist vorgemerkt. Dann nach
  // dem Ende erneut anfordern (liefert den Folgelauf) und erst nach DEM scannen —
  // sonst läse der Scan einen Index, der gleich wieder ersetzt wird.
  async refreshEmbedIndex() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId || this.indexing) return;
    this.indexing = true;
    this.errorMessage = '';
    await this._followEmbedIndex(bookId, 0);
  },

  async _followEmbedIndex(bookId, round) {
    const fail = () => { this.indexing = false; this.errorMessage = window.__app.t('motiv.error.index'); };
    let r;
    try {
      r = await fetchJson('/jobs/embed-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
    } catch (e) { fail(); return; }
    startPoll(this, {
      timerProp: '_embedPollTimer',
      jobId: r.jobId,
      onDone: async () => {
        // Deckel gegen Dauerschleife bei laufend neu vorgemerkten Folgeläufen.
        if (r.rerunQueued && round < 3) { await this._followEmbedIndex(bookId, round + 1); return; }
        this.indexing = false;
        this.embedIndexStale = false;
        if (this.motifs.length) await this.runScan();
      },
      onNotFound: () => { this.indexing = false; },
      onError: fail,
    });
  },

  async runScan() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId || this.scanning) return;
    if (!this.motifs.length) { this.errorMessage = window.__app.t('motiv.scan.noMotifs'); return; }
    this.scanning = true;
    this.scanProgress = 0;
    this.errorMessage = '';
    try {
      const { jobId } = await fetchJson('/jobs/motif-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      this.motivScanJobId = jobId;
      startPoll(this, {
        timerProp: '_scanPollTimer',
        jobId,
        progressProp: 'scanProgress',
        onDone: async () => {
          this.scanning = false;
          this.motivScanJobId = null;
          await this.loadBoard();
          if (this.selectedMotifId) this.selectMotif(this.selectedMotifId);
        },
        onNotFound: () => { this.scanning = false; this.motivScanJobId = null; },
        onError: () => { this.scanning = false; this.motivScanJobId = null; this.errorMessage = window.__app.t('motiv.error.scan'); },
      });
    } catch (e) {
      this.scanning = false;
      this.errorMessage = window.__app.t('motiv.error.scan');
    }
  },
};
