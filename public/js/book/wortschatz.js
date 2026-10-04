// wortschatzMethods — Wortschatz-Analyse (quantitative Stilistik pro Buch).
// Rein rückwärtsgewandt: liest den abgeleiteten Index (GET /lexicon/:book_id),
// stösst den Scan als Job an (POST /jobs/lexicon-scan) und schreibt nie in den
// Buchtext. Gespreadet in cards/wortschatz-card.js.
//
// Die Analyse-Version kommt vom Server (`thresholds.version`) — hier steht KEINE
// Kopie davon: eine Frontend-Kopie driftet unbemerkt gegen den Server.

import { formatNumber, localeTag, tzOpts } from '../utils.js';
import { startPoll } from '../cards/job-helpers.js';
import { tRaw } from '../i18n.js';

// Kein `get x()` in diesem gespreadeten Modul — Spread würde Getter beim Mount
// mit falschem `this` auslösen. Reine Getter leben inline im Karten-Literal.
export const wortschatzMethods = {
  async loadWortschatz() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.wortschatzData = null; return; }
    this.wortschatzLoadError = false;
    try {
      const r = await fetch('/lexicon/' + encodeURIComponent(bookId), { credentials: 'same-origin' });
      if (!r.ok) { this.wortschatzData = null; this.wortschatzLoadError = true; return; }
      this.wortschatzData = await r.json();
    } catch {
      this.wortschatzData = null;
      this.wortschatzLoadError = true;
    }
  },

  // Scan anstossen. Manuell ausgelöst heisst „ich will jetzt eine Zahl sehen" —
  // der Server überspringt in diesem Pfad seinen Delta-Skip.
  async runWortschatzScan() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.wortschatzLoading) return;
    this.wortschatzLoading = true;
    this.wortschatzStatus = window.__app?.t?.('wortschatz.running') || '';
    try {
      const r = await fetch('/jobs/lexicon-scan', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.jobId) {
        this.wortschatzLoading = false;
        this.wortschatzStatus = tRaw('wortschatz.error');
        return;
      }
      this._pollWortschatz(j.jobId);
    } catch (e) {
      this.wortschatzLoading = false;
      this.wortschatzStatus = tRaw('common.errorColon') + (e.message || '');
    }
  },

  _pollWortschatz(jobId) {
    const failed = () => {
      this.wortschatzLoading = false;
      this.wortschatzStatus = tRaw('wortschatz.error');
    };
    startPoll(this, {
      timerProp: '_wortschatzPollTimer',
      jobId,
      intervalMs: 1000,
      progressProp: 'wortschatzProgress',
      onDone: async () => {
        this.wortschatzLoading = false;
        this.wortschatzStatus = '';
        await this.loadWortschatz();
      },
      onError: failed,
      onNotFound: failed,
    });
  },

  // ── Formatierung ──────────────────────────────────────────────────────────
  // `null` wird zu „–", nicht zu „0". Der Unterschied ist fachlich: 0 heisst
  // „gemessen, Ergebnis null", null heisst „nicht messbar" (Text zu kurz für
  // MTLD/Heaps). Zahlen über die geteilte SSoT, nicht handgerollt.
  wsNum(v, decimals = 0) {
    return formatNumber(v == null ? null : Number(v), Alpine.store('shell').uiLocale, decimals);
  },

  wsPercent(v, decimals = 1) {
    if (v == null || !Number.isFinite(Number(v))) return '–';
    return this.wsNum(Number(v) * 100, decimals) + '%';
  },

  // Vergleichszeile „dein Median ist X" — nur wenn es überhaupt andere gescannte
  // Bücher gibt und die Kennzahl dort messbar war.
  wsPeer(key, decimals = 2, asPercent = false) {
    const p = this.wortschatzData?.peers;
    const v = p ? p[key] : null;
    if (v == null) return '';
    const shown = asPercent ? this.wsPercent(v, decimals) : this.wsNum(v, decimals);
    return window.__app?.t?.('wortschatz.peerMedian', { value: shown, books: p.books }) || '';
  },

  // MATTR ist nur längenrobust, wenn das Fenster voll war. War der Text kürzer,
  // liefert der Server die einfache TTR — das muss sichtbar sein, sonst hält der
  // Autor eine nicht vergleichbare Zahl für vergleichbar.
  // Leeres Buch: MATTR ist „–", eine Fenster-Warnung („nur 0 Wörter") wäre dann
  // Unsinn — ohne Wert gibt es nichts, was nicht vergleichbar sein könnte.
  wsMattrIsRobust() {
    const s = this.wortschatzData?.stats;
    const win = this.wortschatzData?.thresholds?.mattrWindow;
    if (!s || !win || s.mattr == null) return true;
    return (s.mattr_window || 0) >= win;
  },

  // Warum MTLD „–" ist. Zwei verschiedene Gründe, zwei verschiedene Sätze: zu kurz
  // ist etwas anderes als „die Type-Token-Rate fällt nie unter die Schwelle"
  // (jedes Wort neu — kommt bei Listen und sehr kurzen, dichten Texten vor).
  wsMtldNote() {
    const d = this.wortschatzData;
    if (!d?.stats || d.stats.mtld != null) return '';
    const min = d.thresholds?.mtldMinTokens;
    const t = window.__app?.t;
    if (!t) return '';
    return (d.stats.tokens || 0) < (min || 0)
      ? t('wortschatz.kpi.mtldShort', { min })
      : t('wortschatz.kpi.mtldNone');
  },

  // Datums-Display Pflicht über tzOpts() (App-Zeitzone, nicht Browser-TZ).
  wsScannedAt() {
    const at = this.wortschatzData?.stats?.scanned_at;
    if (!at) return '';
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(localeTag(Alpine.store('shell').uiLocale), tzOpts({
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }));
  },

  // Offenlegung des Deckels der Einmalwort-Liste: „300 von 4812". Ohne diese Zeile
  // liest sich ein Ausschnitt als Vollständigkeit — rund die Hälfte aller
  // Wortformen eines Buchs kommt genau einmal vor. Leerstring, solange die Liste
  // wirklich vollständig ist (dann gibt es nichts offenzulegen).
  wsHapaxCapped() {
    const total = this.wortschatzData?.stats?.hapax_listed;
    const shown = this.wortschatzHapax.length;
    if (total == null || !shown || total <= shown) return '';
    return window.__app?.t?.('wortschatz.hapax.capped', {
      shown: this.wsNum(shown), total: this.wsNum(total),
    }) || '';
  },

  // Keyness-Band für die Badge-Färbung. Positiv = in diesem Buch auffällig
  // häufig, negativ = auffällig gemieden.
  wsKeynessClass(v) {
    // 0 heisst „exakt erwartete Rate" — weder auffällig häufig noch gemieden.
    if (v == null || Number(v) === 0) return '';
    if (v >= 15) return 'wortschatz-keyness--high';
    if (v > 0) return 'wortschatz-keyness--mid';
    return 'wortschatz-keyness--neg';
  },

  // ── Kapitel-Band ──────────────────────────────────────────────────────────
  // Auffällig ist ein Kapitel, dessen Delta mehr als eine Standardabweichung über
  // dem Mittel der Kapitel liegt. Relativ, nicht absolut: Delta hat keinen festen
  // Normalbereich, es misst den Abstand zum Durchschnittskapitel DIESES Buchs.
  wsDeltaOutlier(row) {
    if (row?.delta == null) return false;
    const vals = (this.wortschatzData?.chapters || []).map(c => c.delta).filter(v => v != null);
    if (vals.length < 3) return false;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    return sd > 0 && row.delta > mean + sd;
  },

  // Begründung des Deltas in Worten: welche häufigen Wörter das Kapitel öfter bzw.
  // seltener benutzt als der Rest. Ohne sie ist die Zahl eine Behauptung.
  wsDeltaReason(row) {
    const top = row?.delta_top || [];
    const more = top.filter(d => d.z > 0).map(d => d.term);
    const less = top.filter(d => d.z < 0).map(d => d.term);
    const t = window.__app?.t;
    if (!t || (!more.length && !less.length)) return '';
    const parts = [];
    if (more.length) parts.push(t('wortschatz.chapters.more', { words: more.join(', ') }));
    if (less.length) parts.push(t('wortschatz.chapters.less', { words: less.join(', ') }));
    return parts.join(' · ');
  },

  // Hinweis, warum das Kapitel-Band (noch) kein Delta hat.
  wsDeltaNote() {
    const d = this.wortschatzData;
    const rows = d?.chapters || [];
    if (!rows.length || rows.some(c => c.delta != null)) return '';
    return window.__app?.t?.('wortschatz.chapters.noDelta', {
      min: this.wsNum(d.thresholds?.deltaMinTokens), chapters: d.thresholds?.deltaMinChapters,
    }) || '';
  },

  // ── Figuren-Idiolekt ──────────────────────────────────────────────────────
  wsIdiolectTerms(row) {
    return (row?.terms || []).map(t => t.term).join(', ');
  },

  // Abdeckung offenlegen: nur Rede mit eindeutiger Inquit-Formel ist zugeordnet.
  wsIdiolectCoverage() {
    const c = this.wortschatzData?.stats?.idiolect_coverage;
    if (c == null) return '';
    return window.__app?.t?.('wortschatz.figures.coverage', { pct: this.wsPercent(c, 0) }) || '';
  },

  wsOpenStil() {
    window.__app?.toggleStilCard?.();
  },

  wsGotoPage(pageId) {
    if (pageId == null) return;
    window.__app?.gotoPageById?.(Number(pageId));
  },
};
