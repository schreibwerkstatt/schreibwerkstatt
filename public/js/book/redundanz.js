// redundanzMethods — Redundanz-Radar (buchweite Doppelungs-Suche über dem
// Embedding-Index). Rein rückwärtsgewandt: findet quasi-doppelte Seiten-
// Passagen, schreibt nie in den Buchtext. Der Vergleich läuft server-seitig als
// Job (POST /jobs/redundancy); diese Methoden triggern ihn, pollen und rendern
// die Paar-Liste. Gespreadet in cards/redundanz-card.js.

import { startPoll } from '../cards/job-helpers.js';
import { tRaw } from '../i18n.js';

// Fallback-Bänder (bge-m3-Cosinus), falls /config noch nicht geladen ist. Die
// massgeblichen Werte stehen in Alpine.store('config').redundancyThresholds
// (App-Settings redundancy.*, im Admin-Semantik-Tab modellabhängig justierbar).
// Server clamped zusätzlich auf 0.70–0.97.
const THRESHOLDS = { strict: 0.88, medium: 0.82, loose: 0.76 };

// Kein `get x()` in diesem gespreadeten Modul — Spread würde Getter beim Mount
// sofort mit falschem `this` auslösen (Karte mountet nicht). Reine Getter
// (redundanzAvailable, redundanzHasIndex) leben inline im Karten-Literal.
export const redundanzMethods = {
  redundanzThresholdValue() {
    const t = this.$store?.config?.redundancyThresholds || THRESHOLDS;
    return t[this.redundanzThreshold] ?? t.medium ?? THRESHOLDS.medium;
  },

  setRedundanzThreshold(band) {
    if (!THRESHOLDS[band] || band === this.redundanzThreshold) return;
    this.redundanzThreshold = band;
  },

  // Index-Frische fürs aktuelle Buch (ob überhaupt ein Semantik-Index existiert).
  async loadRedundanzIndexStatus() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.$store.config?.semanticSearchEnabled) { this.redundanzIndexInfo = null; return; }
    try {
      const r = await fetch('/search/semantic/status?book_id=' + encodeURIComponent(bookId), { credentials: 'same-origin' });
      if (!r.ok) { this.redundanzIndexInfo = null; return; }
      const j = await r.json();
      this.redundanzIndexInfo = j.enabled ? j : null;
    } catch { this.redundanzIndexInfo = null; }
  },

  // Analyse starten: Job anstossen + pollen. Kein Auto-Run beim Öffnen (teuer).
  async runRedundanz() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.redundanzLoading) return;
    this.redundanzLoading = true;
    this.redundanzProgress = 0;
    this.redundanzResult = null;
    this.redundanzStatus = window.__app?.t?.('redundanz.running') || '';
    try {
      const r = await fetch('/jobs/redundancy', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, threshold: this.redundanzThresholdValue() }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.jobId) {
        this.redundanzLoading = false;
        this.redundanzStatus = j.error_code === 'EMBED_DISABLED'
          ? (window.__app?.t?.('redundanz.needBackend') || '')
          : tRaw('redundanz.error');
        return;
      }
      this._pollRedundanz(j.jobId);
    } catch (e) {
      this.redundanzLoading = false;
      this.redundanzStatus = tRaw('common.errorColon') + (e.message || '');
    }
  },

  _pollRedundanz(jobId) {
    const failed = () => {
      this.redundanzLoading = false;
      this.redundanzStatus = tRaw('redundanz.error');
    };
    startPoll(this, {
      timerProp: '_redundanzPollTimer',
      jobId,
      intervalMs: 1000,
      progressProp: 'redundanzProgress',
      onDone: (j) => {
        this.redundanzLoading = false;
        this.redundanzProgress = 100;
        this.redundanzResult = j.result || { pairs: [] };
        this.redundanzStatus = '';
      },
      onError: failed,
      onNotFound: failed,
    });
  },

  // Aktuellen Seitennamen zur page_id aus dem Nav-Store auflösen (drift-frei,
  // keine Snapshot-Namen im Job-Ergebnis). Fallback: „Seite #id".
  redundanzPageName(pageId) {
    const p = (Alpine.store('nav').pages || []).find(x => String(x.id) === String(pageId));
    if (p) return p.name || p.page_name || ('#' + pageId);
    return (window.__app?.t?.('redundanz.pageFallback', { id: pageId })) || ('#' + pageId);
  },

  // Score-Band für die Badge-Färbung (hoch = kräftiger).
  redundanzScoreClass(score) {
    if (score >= 0.9) return 'redundanz-score--high';
    if (score >= 0.83) return 'redundanz-score--mid';
    return 'redundanz-score--low';
  },

  // Figuren-Dubletten (zweiter Ergebnis-Abschnitt) ──────────────────────────
  // Figurennamen drift-frei aus dem Katalog-Store auflösen (kein Snapshot-Name
  // aus dem Job-Ergebnis); Fallback: der zum Analysezeitpunkt gespeicherte Name.
  // Voller Name statt Kurzname: bei Dubletten ist genau der Unterschied gefragt.
  redundanzFigurName(figId, fallback) {
    const f = (Alpine.store('catalog')?.figuren || []).find(x => String(x.id) === String(figId));
    return f?.name || fallback || ('#' + figId);
  },

  // Badge-Text für die Art des Fundes (alias = namensverschieden, das
  // nicht-triviale Signal; duplicate = namensgleich/-überlappend).
  redundanzDupeKindLabel(kind) {
    return window.__app?.t?.('redundanz.fig.kind.' + (kind === 'alias' ? 'alias' : 'duplicate')) || '';
  },
};
