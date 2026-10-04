// buchlandkarteMethods — Buchlandkarte: die Seiten des Buchs als Punktwolke über
// dem Embedding-Index. Rein rückwärtsgewandt (liest den Index, schreibt nie in
// den Buchtext). Die Projektion und alle Kennzahlen rechnet der Server als Job
// (POST /jobs/book-map, Mathematik in lib/book-map.js); diese Methoden triggern
// ihn, pollen und zeichnen. Gespreadet in cards/buchlandkarte-card.js.
//
// WAS DIE KARTE ZEIGT: Nähe. Zwei Punkte nebeneinander heissen „diese zwei Seiten
// reden über dasselbe" — und damit werden drei Dinge sichtbar, die eine
// Trefferliste nicht zeigen kann: übereinanderliegende Kapitel-Wolken (zwei
// Kapitel erzählen dasselbe), ein in zwei Wolken zerfallendes Kapitel (ein
// Teilungsvorschlag) und die Seite weit draussen (der Exkurs, der Blindtext).
//
// WAS DIE ACHSEN NICHT SIND: sie haben keine Bedeutung und bekommen darum keine
// Beschriftung — nur die relative Lage zählt. Wieviel von der Wolke das Bild
// überhaupt zeigt, sagt `explainedVariance`; das wird ausgewiesen statt
// verschwiegen (gleiche Ehrlichkeitsregel wie beim Einmalwort-Deckel des
// Wortschatzes).
//
// SEITEN- UND KAPITELNAMEN kommen aus der ohnehin geladenen Navigationsliste
// (`$store.nav.pages`), nie aus dem Job-Ergebnis: ein Name dort wäre ein
// Snapshot, der nach einer Umbenennung falsch dasteht.

import { loadChart } from '../lazy-libs.js';
import { BOOK_COLORS } from '../cards/my-stats-chart-methods.js';
import { startPoll } from '../cards/job-helpers.js';
import { tRaw } from '../i18n.js';
import { createChartHolder, cssVar } from '../cards/chart-holder.js';
import { dateTimeFormat } from '../utils.js';

// Ausserhalb von Alpine gehalten, damit der Reaktivitäts-Proxy die Chart.js-
// Instanz nicht beschädigt (gleiche Begründung wie in book/bookstats.js).
const _map = createChartHolder();

// Punkt-Radius: Grundgrösse plus ein wenig für die Länge der Seite (Chunk-Zahl).
// Bewusst flach gedeckelt — die Karte soll Lage zeigen, nicht Umfang, und grosse
// Scheiben verdecken ihre Nachbarn.
const R_BASE = 3;
const R_MAX_BONUS = 4;

// Unter drei Punkten gibt `project2d` keine Projektion zurueck (alle Koordinaten
// 0) — dieselbe Untergrenze wie dort. Ein Bild mit zwei Punkten in der Mitte und
// „0% der Streuung" darunter waere kein Ergebnis, sondern eine Irritation.
const MIN_MAP_POINTS = 3;

// Abgeblendete Kapitel bei aktiver Hervorhebung: Alpha-Suffix der Hex-Farbe.
const ALPHA_ON = 'cc';
const ALPHA_OFF = '22';

// Letztes Ergebnis je Buch für die Dauer der Browser-Sitzung (Modul-State,
// kein localStorage): Schliessen der Karte oder ein Buchwechsel kostet sonst
// einen neuen Lauf. Kein persistierter Index — das Ergebnis bleibt nur so lange
// wie der Tab, und „Neu zeichnen" holt den aktuellen Stand.
const _resultCache = new Map();

// Kapitelfarbe nach Gliederungs-Position. Die ersten zwölf aus der App-Palette,
// danach Goldener-Winkel-Farbtöne — sonst trügen Kapitel 1 und 13 dieselbe
// Farbe und die Karte zeigte eine Überlagerung, die es nicht gibt.
function _chapterColor(ix) {
  if (ix < BOOK_COLORS.length) return BOOK_COLORS[ix];
  const hue = ((ix - BOOK_COLORS.length) * 137.508 + 20) % 360;
  return _hslHex(hue, 0.55, 0.52);
}

function _hslHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const hex = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  return '#' + hex(f(0)) + hex(f(8)) + hex(f(4));
}

/** Vom destroy() der Karte gerufen: Modul-State freigeben. */
export function _destroyBookMapChart() {
  _map.destroy();
}
export function _disconnectBookMapThemeObserver() {
  _map.disconnect();
}

// Ein Canvas kann keine CSS-Custom-Properties auflösen — beim Theme-Wechsel muss
// darum neu gezeichnet werden (gleiche Regel wie im Figuren-Graph, siehe
// graph-kit.js#observeThemeChange).
function _ensureThemeObserver(component) {
  _map.ensureThemeRedraw(() => {
    if (!window.__app?.showBuchlandkarteCard || window.__app.buchlandkarteTab !== 'map') return;
    _destroyBookMapChart();
    component.renderBookMap();
  });
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
    try {
      const r = await fetch('/search/semantic/status?book_id=' + encodeURIComponent(bookId), { credentials: 'same-origin' });
      if (!r.ok) { this.bookMapIndexInfo = null; this.bookMapIndexError = r.status !== 401; return; }
      const j = await r.json();
      this.bookMapIndexInfo = j.enabled ? j : null;
    } catch { this.bookMapIndexInfo = null; this.bookMapIndexError = true; }
  },

  /** Zuletzt berechnete Karte dieses Buchs aus dem Sitzungs-Cache zeigen. */
  restoreBookMapResult() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.bookMapResult || this.bookMapLoading) return;
    const cached = _resultCache.get(String(bookId));
    if (!cached) return;
    this.bookMapResult = cached;
    this.$nextTick(() => this.renderBookMap());
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
  // eine bewusste Handlung bleiben (wie beim Redundanz-Radar).
  async runBookMap() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.bookMapLoading) return;
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
        body: JSON.stringify({ book_id: bookId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.jobId) {
        this.bookMapLoading = false;
        this.bookMapStatus = tRaw(
          j.error_code === 'EMBED_DISABLED' ? 'buchlandkarte.needBackend' : 'buchlandkarte.error',
        );
        return;
      }
      this._pollBookMap(j.jobId);
    } catch (e) {
      this.bookMapLoading = false;
      this.bookMapStatus = tRaw('common.errorColon') + (e.message || '');
    }
  },

  _pollBookMap(jobId) {
    const failed = () => {
      this.bookMapLoading = false;
      this.bookMapStatus = tRaw('buchlandkarte.error');
    };
    startPoll(this, {
      timerProp: '_bookMapPollTimer',
      jobId,
      intervalMs: 1000,
      progressProp: 'bookMapProgress',
      onDone: (j) => {
        this.bookMapLoading = false;
        this.bookMapProgress = 100;
        this.bookMapResult = j.result || { pages: [], chapters: [], outliers: [] };
        const bookId = Alpine.store('nav').selectedBookId;
        if (bookId && j.result) _resultCache.set(String(bookId), j.result);
        this.bookMapStatus = '';
        // Canvas existiert erst, wenn das Ergebnis-Template gerendert ist.
        this.$nextTick(() => this.renderBookMap());
      },
      onError: failed,
      onNotFound: failed,
    });
  },

  // ── Zeichnen ──────────────────────────────────────────────────────────────

  /**
   * Punkte nach Kapitel in Chart.js-Datasets gruppieren. Reihenfolge = Buch-
   * Reihenfolge (aus der Navigationsliste), damit die Legende der Gliederung
   * folgt. Die Farbe hängt an der Position des Kapitels in der GLIEDERUNG,
   * nicht an der Zahl der Kapitel mit Punkten — sonst verschöbe die erste
   * indizierte Seite eines frühen Kapitels alle Farben dahinter.
   * Seiten ohne Kapitel kommen als letzte, neutral gefärbte Gruppe.
   */
  _bookMapDatasets(pages) {
    const order = [];
    const seen = new Set();
    for (const p of (Alpine.store('nav').pages || [])) {
      const key = p.chapter_id == null ? '' : String(p.chapter_id);
      if (seen.has(key)) continue;
      seen.add(key);
      order.push(p.chapter_id ?? null);
    }
    // Kapitel, die die Navigationsliste nicht kennt (Seite verschoben, Liste
    // noch nicht neu geladen), hinten anhängen statt verschweigen.
    for (const pt of pages) {
      const key = pt.chapterId == null ? '' : String(pt.chapterId);
      if (!seen.has(key)) { seen.add(key); order.push(pt.chapterId ?? null); }
    }

    const groups = new Map();
    for (const pt of pages) {
      const key = pt.chapterId == null ? '' : String(pt.chapterId);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(pt);
    }

    const muted = cssVar('--color-muted');
    const out = [];
    let colorIx = 0;
    for (const chapterId of order) {
      const key = chapterId == null ? '' : String(chapterId);
      const pts = groups.get(key);
      const color = chapterId == null ? muted : _chapterColor(colorIx++);
      if (!pts?.length) continue;
      out.push({
        label: this.bookMapChapterName(chapterId),
        chapterId: chapterId ?? null,
        _color: color,
        data: pts.map(pt => ({
          x: pt.x, y: pt.y, pageId: pt.id,
          r: R_BASE + Math.min(R_MAX_BONUS, Math.max(0, (pt.chunks || 1) - 1)),
        })),
        backgroundColor: color + ALPHA_ON,
        borderColor: color,
        borderWidth: 1,
        pointRadius: ctx => ctx.raw?.r ?? R_BASE,
        pointHoverRadius: ctx => (ctx.raw?.r ?? R_BASE) + 3,
      });
    }
    return out;
  },

  async renderBookMap() {
    const res = this.bookMapResult;
    if (!this.bookMapHasMap()) return;
    const canvas = document.getElementById('bookMapCanvas');
    if (!canvas) return;
    try { await loadChart(); } catch { return; }
    _destroyBookMapChart();
    _ensureThemeObserver(this);

    const muted = cssVar('--color-muted');
    const gridLine = cssVar('--color-border');
    const t = (k, p) => window.__app?.t?.(k, p) || k;

    _map.set(new Chart(canvas, {
      type: 'scatter',
      data: { datasets: this._bookMapDatasets(res.pages) },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { color: muted, boxWidth: 10, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: ctx => ` ${this.bookMapPageName(ctx.raw?.pageId)} — ${ctx.dataset.label}`,
            },
          },
        },
        onClick: (_evt, elements) => {
          const el = elements?.[0];
          if (!el) return;
          const pt = _map.get()?.data?.datasets?.[el.datasetIndex]?.data?.[el.index];
          if (pt?.pageId) this.bookMapGotoPage(pt.pageId);
        },
        scales: {
          // FESTER Wertebereich auf BEIDEN Achsen, nicht Chart.js' Auto-Fit.
          // `project2d` skaliert x und y mit DEMSELBEN Faktor in die Box [-1,1];
          // liesse man Chart.js selbst skalieren, streckte es eine schmale
          // y-Streuung auf die volle Canvas-Höhe — und genau die Verzerrung,
          // die die Projektion vermeidet, käme in der Anzeige zurück.
          // Zusammen mit dem quadratischen Rahmen (--> buchlandkarte.css,
          // aspect-ratio: 1) ergibt das gleiche Einheiten auf beiden Achsen.
          //
          // Zahlenwerte sind bedeutungslos → keine Ticks. Das Gitter bleibt als
          // Orientierung für Abstände.
          x: { min: -1, max: 1, grid: { color: gridLine }, ticks: { display: false }, title: { display: false } },
          y: { min: -1, max: 1, grid: { color: gridLine }, ticks: { display: false }, title: { display: false } },
        },
      },
    }));
    // Für Screenreader und als Titel-Attribut: das Canvas selbst ist stumm.
    canvas.setAttribute('aria-label', t('buchlandkarte.canvasAria', { n: res.pages.length }));
    // Nach Theme-Redraw oder Cache-Restore die Hervorhebung wieder anlegen.
    this._applyBookMapFocus();
  },

  // ── Hervorhebung ──────────────────────────────────────────────────────────

  /**
   * Kapitel hervorheben: es selbst und sein nächstes Kapitel in voller Farbe,
   * alle anderen abgeblendet — so wird „liegen die zwei Wolken übereinander?"
   * sichtbar statt nur als Zahl. Zweiter Klick hebt die Hervorhebung auf.
   */
  bookMapToggleFocus(chapterId) {
    this.bookMapFocusChapter = this.bookMapFocusChapter === chapterId ? null : chapterId;
    this._applyBookMapFocus();
  },

  bookMapIsFocused(chapterId) {
    return this.bookMapFocusChapter != null && this.bookMapFocusChapter === chapterId;
  },

  _applyBookMapFocus() {
    const chart = _map.get();
    if (!chart) return;
    const focus = this.bookMapFocusChapter;
    const nearest = focus == null ? null
      : (this.bookMapResult?.chapters || []).find(c => c.chapterId === focus)?.nearestChapterId ?? null;
    for (const ds of chart.data.datasets) {
      const on = focus == null || ds.chapterId === focus || (nearest != null && ds.chapterId === nearest);
      ds.backgroundColor = ds._color + (on ? ALPHA_ON : ALPHA_OFF);
      ds.borderColor = on ? ds._color : ds._color + ALPHA_OFF;
    }
    chart.update('none');
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

  /** Reicht die Datenlage fuer eine Karte? Sonst nur die Kennzahlen darunter. */
  bookMapHasMap() {
    return (this.bookMapResult?.pages?.length || 0) >= MIN_MAP_POINTS;
  },

  /**
   * Aussagekraft der Projektion als Band für den Hinweistext. Unter einem
   * Drittel erklärter Streuung ist das Bild eine schwache Skizze und darf keine
   * Nähe behaupten — der Hinweis sagt das, statt es dem Betrachter zu überlassen.
   */
  bookMapVarianceBand() {
    const v = this.bookMapResult?.explainedVariance ?? 0;
    if (v >= 0.5) return 'strong';
    if (v >= 0.3) return 'ok';
    return 'weak';
  },

  bookMapVariancePct() {
    return Math.round((this.bookMapResult?.explainedVariance ?? 0) * 100);
  },
};
