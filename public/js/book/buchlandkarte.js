// buchlandkarteMethods — Buchlandkarte: die Abschnitte des Buchs über dem
// Embedding-Index, als Karte (Tab „Landkarte") und als Ähnlichkeitsmatrix in
// Lesereihenfolge (Tab „Verlauf"). Rein rückwärtsgewandt (liest den Index,
// schreibt nie in den Buchtext). Projektion, Matrix und alle Kennzahlen rechnet
// der Server als Job (POST /jobs/book-map, Mathematik in lib/book-map.js);
// diese Methoden triggern ihn, pollen und zeichnen. Gespreadet in
// cards/buchlandkarte-card.js.
//
// Aufteilung: Lauf, Namen und Kennzahl-Tabellen hier; Karte
// (buchlandkarte/map.js), Achsen + Pole + KI-Benennung (buchlandkarte/axes.js)
// und Matrix (buchlandkarte/matrix.js) in eigenen Modulen.
//
// SEITEN- UND KAPITELNAMEN kommen aus der ohnehin geladenen Navigationsliste
// (`$store.nav.pages`), nie aus dem Job-Ergebnis: ein Name dort wäre ein
// Snapshot, der nach einer Umbenennung falsch dasteht. Einzige Ausnahme sind
// die Pol-Labels (Figur/Ort/Begriff), die die Achse so beschriften, wie sie
// gerechnet wurde.

import { startPoll } from '../cards/job-helpers.js';
import { tRaw } from '../i18n.js';
import { dateTimeFormat } from '../utils.js';
import { mapMethods, _destroyBookMapChart as _destroyMap, _disconnectBookMapThemeObserver as _disconnectMap } from './buchlandkarte/map.js';
import { axesMethods, emptyBookMapPoles } from './buchlandkarte/axes.js';
import { matrixMethods, _destroyBookMatrix, _disconnectBookMatrixThemeObserver } from './buchlandkarte/matrix.js';
import { resultCache } from './buchlandkarte/cache.js';

export { emptyBookMapPoles };

/** Vom destroy() der Karte und vor jedem Lauf gerufen: beide Charts freigeben. */
export function _destroyBookMapChart() {
  _destroyMap();
  _destroyBookMatrix();
}
export function _disconnectBookMapThemeObserver() {
  _disconnectMap();
  _disconnectBookMatrixThemeObserver();
}

export const buchlandkarteMethods = {
  // ── Namen aus der Navigationsliste ────────────────────────────────────────

  bookMapPageName(pageId) {
    const p = (Alpine.store('nav').pages || []).find(x => String(x.id) === String(pageId));
    return p?.name || window.__app?.t?.('buchlandkarte.pageFallback', { id: pageId }) || ('#' + pageId);
  },

  bookMapChapterName(chapterId) {
    if (chapterId == null) return window.__app?.t?.('buchlandkarte.noChapter') || '';
    const p = (Alpine.store('nav').pages || []).find(x => String(x.chapter_id) === String(chapterId));
    return p?.chapterName || window.__app?.t?.('buchlandkarte.chapterFallback', { id: chapterId }) || ('#' + chapterId);
  },

  bookMapGotoPage(pageId) {
    window.__app?.gotoPageById?.(Number(pageId));
  },

  // ── Index-Frische ─────────────────────────────────────────────────────────

  // Scheitert die Abfrage (Netz, 500), ist der Index-Stand UNBEKANNT — nicht
  // „kein Index". `bookMapIndexError` hält den Lauf offen; der Job selbst
  // meldet ein leeres Ergebnis, falls wirklich nichts da ist.
  async loadBookMapIndexStatus() {
    const bookId = Alpine.store('nav').selectedBookId;
    this.bookMapIndexError = false;
    if (!bookId || !this.$store.config?.semanticSearchEnabled) { this.bookMapIndexInfo = null; return; }
    // Späte Antwort für ein inzwischen abgewähltes Buch verwerfen.
    const stale = () => Alpine.store('nav').selectedBookId !== bookId;
    try {
      const r = await fetch('/search/semantic/status?book_id=' + encodeURIComponent(bookId), { credentials: 'same-origin' });
      if (stale()) return;
      if (!r.ok) { this.bookMapIndexInfo = null; this.bookMapIndexError = r.status !== 401; return; }
      const j = await r.json();
      if (stale()) return;
      this.bookMapIndexInfo = j.enabled ? j : null;
    } catch {
      if (stale()) return;
      this.bookMapIndexInfo = null; this.bookMapIndexError = true;
    }
  },

  /** Zuletzt berechnete Karte dieses Buchs aus dem Sitzungs-Cache zeigen. */
  restoreBookMapResult() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.bookMapResult || this.bookMapLoading) return;
    const cached = resultCache.get(String(bookId));
    if (!cached) return;
    this._adoptBookMapResult(cached);
  },

  /** Ergebnis übernehmen und die Bedienelemente auf seine Optionen setzen. */
  _adoptBookMapResult(res) {
    this.bookMapResult = res;
    const opts = res.options || {};
    this.bookMapGranularity = opts.granularity === 'chunk' ? 'chunk' : 'page';
    this.bookMapAxisMode = opts.poles ? 'poles' : 'pca';
    if (opts.poles) this.bookMapPoles = this._bookMapPolesFromOptions(opts.poles);
    this.bookMapAxisPair = this._bookMapDefaultPair();
    this.bookMapLabels = res._labels || null;
    this.bookMapLabelStatus = '';
    this.bookMapMatrixPick = null;
    this.bookMapMatrixHover = null;
    this.$nextTick(() => this._renderBookMapTab());
  },

  /** Den sichtbaren Tab zeichnen (Canvas existiert nur im sichtbaren Panel). */
  _renderBookMapTab() {
    const tab = window.__app?.buchlandkarteTab;
    if (tab === 'matrix') this.renderBookMatrix();
    else this.renderBookMap();
  },

  /** Meta-Zeile zum Index-Stand der berechneten Karte (leer, wenn nichts zu sagen ist). */
  bookMapIndexNote() {
    const res = this.bookMapResult;
    if (!res) return '';
    const t = (k, p) => window.__app?.t?.(k, p) || k;
    const parts = [];
    if (res.lastIndexedAt) {
      const when = dateTimeFormat(Alpine.store('shell')?.uiLocale, { dateStyle: 'short', timeStyle: 'short' })
        .format(new Date(res.lastIndexedAt));
      parts.push(t('buchlandkarte.meta.indexedAt', { when }));
    }
    if (res.missingPages > 0) parts.push(t('buchlandkarte.meta.missing', { n: res.missingPages, total: res.totalPages }));
    return parts.join(' · ');
  },

  // ── Lauf ──────────────────────────────────────────────────────────────────

  // Kein Auto-Run beim Öffnen: die Projektion ist der teuerste Teil und soll
  // eine bewusste Handlung bleiben (wie beim Redundanz-Radar). Die Optionen
  // (Passagen statt Abschnitte, eigene Pole) gelten für den nächsten Lauf.
  async runBookMap() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.bookMapLoading) return;
    let poles = null;
    if (this.bookMapAxisMode === 'poles') {
      poles = this._bookMapPolesPayload();
      if (!poles) { this.bookMapStatus = tRaw('buchlandkarte.poles.incomplete'); return; }
    }
    this.bookMapLoading = true;
    this.bookMapProgress = 0;
    this.bookMapResult = null;
    this.bookMapFocusChapter = null;
    _destroyBookMapChart();
    this.bookMapStatus = window.__app?.t?.('buchlandkarte.running') || '';
    try {
      const r = await fetch('/jobs/book-map', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, granularity: this.bookMapGranularity, poles }),
      });
      const j = await r.json().catch(() => ({}));
      // Buch während des POST gewechselt: onBookChanged hat die Anzeige schon
      // zurückgesetzt; den Job des alten Buches nicht in der neuen pollen.
      if (Alpine.store('nav').selectedBookId !== bookId) return;
      if (!r.ok || !j.jobId) {
        this.bookMapLoading = false;
        this.bookMapStatus = tRaw(
          j.error_code === 'EMBED_DISABLED' ? 'buchlandkarte.needBackend' : 'buchlandkarte.error',
        );
        return;
      }
      this._pollBookMap(j.jobId, bookId);
    } catch (e) {
      if (Alpine.store('nav').selectedBookId !== bookId) return;
      this.bookMapLoading = false;
      this.bookMapStatus = tRaw('common.errorColon') + (e.message || '');
    }
  },

  // `bookId` = Buch, für das der Lauf gestartet wurde. Das Ergebnis gehört in
  // dessen Cache-Slot, auch wenn inzwischen ein anderes Buch gewählt ist —
  // angezeigt wird es dann nicht.
  _pollBookMap(jobId, bookId) {
    const stale = () => Alpine.store('nav').selectedBookId !== bookId;
    const failed = (job) => {
      if (stale()) return;
      this.bookMapLoading = false;
      this.bookMapStatus = job?.error && job.error.startsWith('job.')
        ? window.__app.t(job.error, job.errorParams)
        : tRaw('buchlandkarte.error');
    };
    startPoll(this, {
      timerProp: '_bookMapPollTimer',
      jobId,
      intervalMs: 1000,
      progressProp: 'bookMapProgress',
      onDone: (j) => {
        const res = j.result || { pages: [], chapters: [], outliers: [] };
        if (bookId && j.result) resultCache.set(String(bookId), res);
        if (stale()) return;
        this.bookMapLoading = false;
        this.bookMapProgress = 100;
        this.bookMapStatus = '';
        // Canvas existiert erst, wenn das Ergebnis-Template gerendert ist.
        this._adoptBookMapResult(res);
      },
      onError: failed,
      onNotFound: () => failed(null),
    });
  },

  // ── Kennzahlen-Zeilen fürs Template ───────────────────────────────────────

  /** Kapitel-Zeilen mit aufgelösten Namen (sortableTable rendert `sorted`). */
  bookMapChapterRows() {
    const rows = this.bookMapResult?.chapters || [];
    return rows.map(c => ({
      ...c,
      name: this.bookMapChapterName(c.chapterId),
      nearestName: c.nearestChapterId == null ? '' : this.bookMapChapterName(c.nearestChapterId),
      cohesionPct: c.cohesion == null ? null : Math.round(c.cohesion * 100),
      spreadPct: c.spread == null ? null : Math.round(c.spread * 100),
      nearestPct: c.nearestScore == null ? null : Math.round(c.nearestScore * 100),
      ...this._bookMapSplitInfo(c.split),
    }));
  },

  /**
   * Teilungsbefund fürs Template. Liegen die zwei Gruppen in der Gliederung
   * hintereinander, ist der Bruch eine konkrete Seite („ab hier ein anderes
   * Thema") — das ist der Teilungsvorschlag. Wechseln sie sich ab, gibt es
   * keinen Schnitt, nur zwei verflochtene Themen.
   */
  _bookMapSplitInfo(split) {
    if (!split?.groups?.length) return { splitText: '', splitPageId: null, splitPageName: '' };
    const t = (k, p) => window.__app?.t?.(k, p) || k;
    const pos = new Map((Alpine.store('nav').pages || []).map((p, i) => [String(p.id), i]));
    const at = (id) => pos.get(String(id));
    const [ga, gb] = split.groups;
    const a = ga.map(at);
    const b = gb.map(at);
    const params = { a: ga.length, b: gb.length };
    if (![...a, ...b].every(v => v != null)) return { splitText: t('buchlandkarte.split.mixed', params), splitPageId: null, splitPageName: '' };
    const [first, second] = Math.max(...a) < Math.min(...b) ? [ga, gb]
      : Math.max(...b) < Math.min(...a) ? [gb, ga] : [null, null];
    if (!first) return { splitText: t('buchlandkarte.split.mixed', params), splitPageId: null, splitPageName: '' };
    const breakId = second.reduce((m, id) => (at(id) < at(m) ? id : m), second[0]);
    return {
      splitText: t('buchlandkarte.split.contiguous', { a: first.length, b: second.length }),
      splitPageId: breakId,
      splitPageName: this.bookMapPageName(breakId),
    };
  },

  bookMapOutlierRows() {
    const rows = this.bookMapResult?.outliers || [];
    return rows.map(o => ({
      ...o,
      name: this.bookMapPageName(o.id),
      chapterName: this.bookMapChapterName(o.chapterId),
      distancePct: Math.round((o.distance ?? 0) * 100),
    }));
  },

  ...mapMethods,
  ...axesMethods,
  ...matrixMethods,
};
