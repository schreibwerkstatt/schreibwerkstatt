// redundanzMethods — Redundanz-Radar (buchweite Doppelungs-Suche über dem
// Embedding-Index, docs/redundanz.md). Rein rückwärtsgewandt: findet quasi-
// doppelte Seiten-Passagen, schreibt nie in den Buchtext. Der Vergleich läuft
// server-seitig als Job (POST /jobs/redundancy); diese Methoden triggern ihn,
// hängen sich an einen laufenden Job wieder an, laden das zuletzt gespeicherte
// Ergebnis (GET /redundancy/:book_id) und pflegen die ignorierten Paare.
// Gespreadet in cards/redundanz-card.js.

import { startPoll } from '../cards/job-helpers.js';
import { tRaw } from '../i18n.js';
import { tzOpts } from '../utils/date.js';
import { fetchJson } from '../utils/net.js';

// Fallback-Bänder (bge-m3-Cosinus), falls /config noch nicht geladen ist. Die
// massgeblichen Werte stehen in Alpine.store('config').redundancyThresholds
// (App-Settings redundancy.*, im Admin-Semantik-Tab modellabhängig justierbar).
// Server clamped zusätzlich auf 0.70–0.97.
const THRESHOLDS = { strict: 0.88, medium: 0.82, loose: 0.76 };
const BANDS = ['strict', 'medium', 'loose'];

const pairKey = (kind, pair) => `${kind}:${pair.a_id}:${pair.b_id}`;

// Kein `get x()` in diesem gespreadeten Modul — Spread würde Getter beim Mount
// sofort mit falschem `this` auslösen (Karte mountet nicht). Reine Getter
// (redundanzAvailable, redundanzHasIndex) leben inline im Karten-Literal.
export const redundanzMethods = {
  _redundanzBands() {
    return this.$store?.config?.redundancyThresholds || THRESHOLDS;
  },

  redundanzThresholdValue() {
    const t = this._redundanzBands();
    return t[this.redundanzThreshold] ?? t.medium ?? THRESHOLDS.medium;
  },

  setRedundanzThreshold(band) {
    if (!THRESHOLDS[band] || band === this.redundanzThreshold) return;
    this.redundanzThreshold = band;
  },

  // Band, das zu einer Schwelle eines Ergebnisses gehört (nächstliegender Wert):
  // ein gespeichertes oder wieder angehängtes Ergebnis zeigt sein eigenes Band
  // an, nicht das zuletzt angeklickte.
  _redundanzBandFor(value) {
    const t = this._redundanzBands();
    let best = this.redundanzThreshold;
    let dist = Infinity;
    for (const b of BANDS) {
      const d = Math.abs(Number(t[b]) - Number(value));
      if (d < dist) { dist = d; best = b; }
    }
    return best;
  },

  _redundanzApplyResult(result) {
    this.redundanzResult = result || null;
    this.redundanzOpen = {};
    if (result?.threshold != null) this.redundanzThreshold = this._redundanzBandFor(result.threshold);
    if (typeof result?.skipAdjacent === 'boolean') this.redundanzSkipAdjacent = result.skipAdjacent;
  },

  // Beim Öffnen: Index-Stand, letztes Ergebnis und laufende Jobs parallel.
  async loadRedundanz() {
    await Promise.all([
      this.loadRedundanzIndexStatus(),
      this.loadRedundanzLast(),
      this._redundanzReattach(),
    ]);
  },

  // Index-Frische fürs aktuelle Buch (ob ein Semantik-Index existiert und wie
  // viele Einträge sich seit dem letzten Lauf geändert haben).
  async loadRedundanzIndexStatus() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.$store.config?.semanticSearchEnabled) { this.redundanzIndexInfo = null; return; }
    try {
      const r = await fetch('/search/semantic/status?book_id=' + encodeURIComponent(bookId), { credentials: 'same-origin' });
      if (!r.ok) { this.redundanzIndexInfo = null; return; }
      const j = await r.json();
      if (Alpine.store('nav').selectedBookId !== bookId) return;
      this.redundanzIndexInfo = j.enabled ? j : null;
    } catch { this.redundanzIndexInfo = null; }
  },

  // Zuletzt gespeichertes Ergebnis dieses Users. Läuft gerade ein Job, gewinnt
  // dessen Ergebnis (der Poller setzt es später).
  async loadRedundanzLast() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.redundanzAvailable) return;
    try {
      const j = await fetchJson('/redundancy/' + encodeURIComponent(bookId));
      if (Alpine.store('nav').selectedBookId !== bookId) return;
      this.redundanzDismissedCount = j.dismissedCount || 0;
      if (!this.redundanzLoading && !this.redundanzResult && j.result) this._redundanzApplyResult(j.result);
    } catch (e) {
      console.error('[redundanz] letztes Ergebnis:', e);
    }
  },

  // Läuft serverseitig schon ein Radar- oder Index-Job (Reload, Klick auf die
  // Job-Anzeige, Buchwechsel hin und zurück), den Poller wieder anhängen statt
  // eine leere Karte zu zeigen.
  async _redundanzReattach() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    const active = (type) => fetchJson(`/jobs/active?type=${type}&book_id=${encodeURIComponent(bookId)}`)
      .then(j => j?.jobId || null).catch(() => null);
    const [scanJob, indexJob] = await Promise.all([active('redundancy'), active('embed-index')]);
    if (Alpine.store('nav').selectedBookId !== bookId) return;
    if (scanJob && !this._redundanzPollTimer) {
      this.redundanzLoading = true;
      this.redundanzProgress = 0;
      this.redundanzStatus = tRaw('redundanz.alreadyRunning');
      this._pollRedundanz(scanJob);
    }
    if (indexJob && !this._redundanzIndexPollTimer) {
      this.redundanzIndexing = true;
      this._pollRedundanzIndex(indexJob);
    }
  },

  // Analyse starten: Job anstossen + pollen. Kein Auto-Run beim Öffnen (teuer).
  async runRedundanz() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.redundanzLoading) return;
    this.redundanzLoading = true;
    this.redundanzProgress = 0;
    this.redundanzStatus = tRaw('redundanz.running');
    try {
      const r = await fetch('/jobs/redundancy', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: bookId,
          threshold: this.redundanzThresholdValue(),
          skip_adjacent: !!this.redundanzSkipAdjacent,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.jobId) {
        this.redundanzLoading = false;
        this.redundanzStatus = j.error_code === 'EMBED_DISABLED' ? tRaw('redundanz.needBackend') : tRaw('redundanz.error');
        return;
      }
      // Ein Lauf pro Buch: läuft schon einer (evtl. mit anderer Schwelle), kommt
      // dessen Job zurück — das Ergebnis zeigt dann sein eigenes Band.
      if (j.existing) this.redundanzStatus = tRaw('redundanz.alreadyRunning');
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
        this._redundanzApplyResult(j.result || { pairs: [] });
        this.redundanzStatus = '';
      },
      onError: failed,
      onNotFound: failed,
    });
  },

  // Semantik-Index direkt aus der Karte bauen bzw. aktualisieren (derselbe Job
  // wie in der Such-Karte).
  async buildRedundanzIndex() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.redundanzIndexing) return;
    this.redundanzIndexing = true;
    this.redundanzStatus = '';
    try {
      const r = await fetch('/jobs/embed-index', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.jobId) {
        this.redundanzIndexing = false;
        this.redundanzStatus = tRaw('redundanz.indexError');
        return;
      }
      this._pollRedundanzIndex(j.jobId);
    } catch {
      this.redundanzIndexing = false;
      this.redundanzStatus = tRaw('redundanz.indexError');
    }
  },

  _pollRedundanzIndex(jobId) {
    const failed = () => {
      this.redundanzIndexing = false;
      this.redundanzStatus = tRaw('redundanz.indexError');
    };
    startPoll(this, {
      timerProp: '_redundanzIndexPollTimer',
      jobId,
      intervalMs: 1200,
      progressProp: 'redundanzIndexProgress',
      onDone: async () => {
        this.redundanzIndexing = false;
        await this.loadRedundanzIndexStatus();
      },
      onError: failed,
      onNotFound: failed,
    });
  },

  // ── Anzeige ──────────────────────────────────────────────────────────────

  // Seite noch im aktuellen Buch? Seiten, die seit dem Lauf gelöscht oder
  // verschoben wurden, fallen aus der Anzeige eines gespeicherten Ergebnisses.
  // Ist die Navigationsliste (noch) leer, wird nichts ausgeblendet.
  _redundanzPageKnown(pageId) {
    const pages = Alpine.store('nav').pages || [];
    return !pages.length || pages.some(p => String(p.id) === String(pageId));
  },

  redundanzVisiblePairs() {
    return (this.redundanzResult?.pairs || [])
      .filter(p => this._redundanzPageKnown(p.a_id) && this._redundanzPageKnown(p.b_id));
  },

  // Aktuellen Seitennamen zur page_id aus dem Nav-Store auflösen (drift-frei,
  // keine Snapshot-Namen im Job-Ergebnis). Fallback: „Seite #id".
  redundanzPageName(pageId) {
    const p = (Alpine.store('nav').pages || []).find(x => String(x.id) === String(pageId));
    if (p) return p.name || p.page_name || ('#' + pageId);
    return tRaw('redundanz.pageFallback', { id: pageId });
  },

  // Score-Band für die Badge-Färbung, an denselben (modellabhängigen) Schwellen
  // wie die Bänder der Karte: ab „streng" kräftig, ab „mittel" mittel.
  redundanzScoreClass(score) {
    const t = this._redundanzBands();
    if (score >= t.strict) return 'redundanz-score--high';
    if (score >= t.medium) return 'redundanz-score--mid';
    return 'redundanz-score--low';
  },

  // Passage auf- und zuklappen (key = Paar + Seite a/b).
  redundanzIsOpen(key) { return !!this.redundanzOpen[key]; },
  toggleRedundanzOpen(key) {
    this.redundanzOpen = { ...this.redundanzOpen, [key]: !this.redundanzOpen[key] };
  },

  // Lauf-Zeile: Schwelle + Zeitpunkt.
  redundanzRunInfo() {
    const r = this.redundanzResult;
    if (!r) return '';
    const date = r.createdAt
      ? new Date(r.createdAt).toLocaleString(undefined, tzOpts({ dateStyle: 'medium', timeStyle: 'short' }))
      : '';
    return tRaw('redundanz.meta.run', { threshold: Number(r.threshold).toFixed(2), date });
  },

  // Index ist neuer als das Ergebnis → das Ergebnis rechnete auf altem Stand.
  redundanzResultOutdated() {
    const r = this.redundanzResult;
    const last = this.redundanzIndexInfo?.lastIndexedAt;
    return !!(r?.indexedAt && last && last > r.indexedAt);
  },

  // Einträge, die seit dem letzten Index-Lauf geändert wurden.
  redundanzIndexStaleCount() {
    return this.redundanzIndexInfo?.indexed ? (this.redundanzIndexInfo.staleCount || 0) : 0;
  },

  // ── Ignorieren ───────────────────────────────────────────────────────────

  async dismissRedundanzPair(kind, pair) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.redundanzResult) return;
    const key = pairKey(kind, pair);
    if (this.redundanzBusyKey) return;
    this.redundanzBusyKey = key;
    try {
      const j = await fetchJson(`/redundancy/${encodeURIComponent(bookId)}/dismissals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, a_id: pair.a_id, b_id: pair.b_id }),
      });
      this.redundanzDismissedCount = j.dismissedCount ?? this.redundanzDismissedCount + 1;
      const drop = (list) => (list || []).filter(p => pairKey(kind, p) !== key);
      if (kind === 'page') {
        this.redundanzResult = {
          ...this.redundanzResult,
          pairs: drop(this.redundanzResult.pairs),
          totalFound: Math.max(0, (this.redundanzResult.totalFound || 0) - 1),
        };
      } else {
        const f = this.redundanzResult.figures || {};
        this.redundanzResult = {
          ...this.redundanzResult,
          figures: { ...f, pairs: drop(f.pairs), totalFound: Math.max(0, (f.totalFound || 0) - 1) },
        };
      }
    } catch (e) {
      console.error('[redundanz] ignorieren:', e);
      this.redundanzStatus = tRaw('redundanz.dismissError');
    } finally {
      this.redundanzBusyKey = null;
    }
  },

  // Alle ignorierten Paare wieder anzeigen — wirkt ab dem nächsten Lauf.
  async resetRedundanzDismissals() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !this.redundanzDismissedCount) return;
    try {
      await fetchJson(`/redundancy/${encodeURIComponent(bookId)}/dismissals`, { method: 'DELETE' });
      this.redundanzDismissedCount = 0;
      this.redundanzStatus = tRaw('redundanz.dismissed.resetDone');
    } catch (e) {
      console.error('[redundanz] zurücksetzen:', e);
      this.redundanzStatus = tRaw('redundanz.dismissError');
    }
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
    return tRaw('redundanz.fig.kind.' + (kind === 'alias' ? 'alias' : 'duplicate'));
  },
};
