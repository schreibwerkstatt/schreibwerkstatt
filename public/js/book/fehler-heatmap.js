// Fehler-Heatmap: aggregiert Fehlertypen × Kapitel aus jüngstem page_check pro Seite.
// Daten kommen live aus /history/fehler-heatmap/:book_id — kein KI-Call, keine Sync-Phase.
// Methoden werden in Alpine.data('fehlerHeatmapCard') gespreadet; Root-Zugriffe via window.__app.
//
// Die Zell-Darstellung entsteht EINMAL pro Datenstand (`buildFehlerRows`), nicht
// pro Zelle im Template — Muster public/js/book/stil-heatmap.js#buildStilRows.
// Alpine memoisiert Methodenaufrufe in Bindings nicht; 26 Typen x Kapitel x
// mehrere Bindings mit einer Min/Max-Skala darin waren O(Kapitel²) pro Render.
//
// Farbe = DICHTE (Befunde pro 1000 geprüfte Wörter), Zahl = Anzahl. Nach der
// Anzahl gefärbt wäre jedes lange Kapitel in jeder Spalte rot — die Farbe zeigte
// dann den Kapitelumfang, nicht die Fehlerlage.

import { escHtml, fetchJson, formatNumber, heatmapCellVars, HEATMAP_MIN_WORDS, localeTag, minMaxBy, tzOpts } from '../utils.js';
import { loadChart } from '../lazy-libs.js';
import { isSelectedBook } from '../cards/book-guard.js';
import { createChartHolder, cssVar } from '../cards/chart-holder.js';
import { memoMethods } from '../cards/card-memo.js';


// Chart.js-Instanz + Theme-Observer als Modul-State (ausserhalb Alpines Proxy,
// der die Chart-Instanz sonst beschädigt) — analog bookstats.js.
const _trend = createChartHolder();

function _ensureTrendThemeObserver(component) {
  _trend.ensureThemeRedraw(() => {
    if (!window.__app.showFehlerHeatmapCard) return;
    component.renderFehlerTrendChart();
  });
}

export function _disconnectFehlerTrendThemeObserver() { _trend.disconnect(); }

export function _destroyFehlerTrendChart() { _trend.destroy(); }

// Cluster-Gruppierung der Typen-Spalten. Reihenfolge in den Cluster-Arrays = Spalten-Reihenfolge.
// Muss alle Typen aus ALLE_LEKTORAT_TYPEN (public/js/prompts/lektorat-typen.js) abdecken —
// die Heatmap zeigt alle Spalten, unabhängig vom Buchtyp des Buchs: bei einem Roman
// bleiben die Fach-Spalten leer, bei einer wissenschaftlichen Arbeit die Erzähl-Spalten.
// Vollständigkeit gegated durch tests/unit/lektorat-typen-drift.test.mjs.
const FEHLER_CLUSTERS = [
  { key: 'sprache',    typen: ['rechtschreibung', 'grammatik', 'dialogformat'] },
  { key: 'wort',       typen: ['wiederholung', 'schwaches_verb', 'fuellwort', 'filterwort'] },
  { key: 'stil',       typen: ['stil', 'satzbau', 'pleonasmus', 'klischee', 'ki_geruch', 'passiv'] },
  { key: 'erzaehlung', typen: ['show_vs_tell', 'perspektivbruch', 'tempuswechsel'] },
  { key: 'fach',       typen: ['unbelegt', 'begriffsinkonsistenz', 'autorenform', 'hedging'] },
  { key: 'journal',    typen: ['konjunktiv', 'zuschreibung', 'wertung', 'amtsdeutsch'] },
  { key: 'welt',       typen: ['namenskonsistenz', 'figurenmerkmal', 'schauplatzmerkmal', 'anrede'] },
];
const FEHLER_TYPEN = FEHLER_CLUSTERS.flatMap(c => c.typen);

// Spalten-Indizes der jeweils ersten Spalte eines Clusters (fuer Trennlinien).
// Das erste Cluster startet bei 0 und faellt raus — links aussen keine Linie.
// Modul-Konstante, kein Getter: das Template fragt sie einmal PRO ZELLE ab
// (26 Typen x N Kapiteln), und ein Getter haette dabei jedes Mal zwei Arrays
// gebaut. Set statt Array, weil der Zugriff ein Enthaltensein-Test ist.
const FEHLER_CLUSTER_STARTS = new Set(FEHLER_CLUSTERS.reduce((acc, c) => {
  acc.push(acc.at(-1) + c.typen.length);
  return acc;
}, [0]).slice(0, -1).slice(1));

const MODES = ['open', 'applied', 'all'];
const UNCAT = '__uncat__';

/** Zeilen-Schlüssel eines Kapitels — derselbe wie in `matrix`/`details` der Antwort. */
export function fehlerChapterKey(ch) {
  return ch.chapter_id == null ? UNCAT : String(ch.chapter_id);
}

function _coveragePct(ch) {
  return ch.pages_total ? Math.round((ch.pages_checked / ch.pages_total) * 100) : 0;
}

/** Baut die render-fertigen Zeilen aus der Server-Antwort. Pure (kein `this`),
 *  damit ohne Alpine testbar.
 *
 *  Zellregeln:
 *   - Kapitel ohne geprüfte Seite → 'empty' (schraffiert), keine Zahl.
 *   - Geprüft ohne Befund → Dichte 0: geht in die Skala ein und färbt grün. Sonst
 *     stünde das beste Kapitel neutral da und das mit einem Befund grün.
 *   - Unter HEATMAP_MIN_WORDS geprüften Wörtern → 'lowdata': Zahl ja, Farbe nein,
 *     und kein Einfluss auf die Skala. Erreichen weniger als zwei Kapitel die
 *     Schwelle (kurzes Buch), gilt sie nicht — sonst hätte es gar keine Farbe.
 *   - Teilweise geprüft → Farbe blasser (`--heatmap-opacity`, wirkt nur auf den
 *     Hintergrund, nicht auf die Zahl). */
export function buildFehlerRows(data, typen, uiLocale) {
  const chapters = data?.chapters || [];
  if (!chapters.length) return [];
  const matrix = data.matrix || {};

  const checked = chapters.filter(ch => ch.pages_checked > 0);
  const enough = checked.filter(ch => (ch.words_checked || 0) >= HEATMAP_MIN_WORDS);
  const scaleSet = enough.length >= 2 ? enough : checked;
  const inScale = new Set(scaleSet);

  const ranges = new Map();
  for (const typ of typen) {
    ranges.set(typ, minMaxBy(scaleSet, ch => matrix[fehlerChapterKey(ch)]?.[typ]?.per1k ?? 0));
  }

  return chapters.map((ch) => {
    const key = fehlerChapterKey(ch);
    const coveragePct = _coveragePct(ch);
    const isChecked = ch.pages_checked > 0;
    const lowData = isChecked && !inScale.has(ch);
    const opacity = coveragePct < 100 ? 0.5 + (coveragePct / 200) : 1;
    const cells = {};
    for (const typ of typen) {
      const cell = matrix[key]?.[typ];
      const count = cell?.count || 0;
      const per1k = cell?.per1k ?? 0;
      let kind = 'empty';
      let vars = {};
      if (isChecked) {
        const range = ranges.get(typ);
        if (lowData) kind = 'lowdata';
        else if (range.max === range.min) kind = 'neutral';
        else {
          kind = 'tinted';
          vars = heatmapCellVars((per1k - range.min) / (range.max - range.min), opacity);
        }
      }
      const clickable = count > 0;
      cells[typ] = {
        text: count > 0 ? formatNumber(count, uiLocale, 0) : '–',
        cls: `heatmap-cell--${kind}${clickable ? ' heatmap-cell--clickable internal-link' : ''}`,
        vars,
        clickable,
        detailKey: `${key}:${typ}`,
        // Tooltip-Parameter; der Text selbst ist UI-String und entsteht im Template.
        tip: !isChecked ? null : {
          count,
          pages: cell?.pages || 0,
          checkedPages: ch.pages_checked,
          per1k: formatNumber(per1k, uiLocale, 1),
          lowData,
        },
      };
    }
    return {
      key,
      chapter: ch,
      coveragePct,
      wordsLabel: formatNumber(ch.words || 0, uiLocale, 0),
      cells,
    };
  });
}

/** Summenzeile „ganzes Buch" je Typ: Anzahl + Dichte gegen alle geprüften Wörter. */
export function buildFehlerTotals(data, typen, uiLocale) {
  const wordsChecked = (data?.chapters || []).reduce((s, ch) => s + (ch.words_checked || 0), 0);
  const out = {};
  for (const typ of typen) {
    const count = data?.totals?.[typ] || 0;
    const per1k = wordsChecked > 0 ? Math.round((count / wordsChecked) * 1000 * 10) / 10 : 0;
    out[typ] = {
      text: count > 0 ? formatNumber(count, uiLocale, 0) : '–',
      count,
      per1k: formatNumber(per1k, uiLocale, 1),
    };
  }
  return { cells: out, wordsChecked, wordsCheckedLabel: formatNumber(wordsChecked, uiLocale, 0) };
}

/** Nenner der Fehlerdichte einer Fassung: geprüfte Wörter, sofern die Fassung
 *  sie trägt (lib/lektorat-metrics.js#words_checked). Ältere Fassungen kennen nur
 *  den Buchumfang — ihr Punkt ist dann eine Näherung (`approx`) und wird im Chart
 *  so gezeichnet. Gegen den Buchumfang sänke die Dichte mit jeder ungeprüft
 *  dazugeschriebenen Seite, ohne dass der Text besser geworden wäre. */
export function fehlerTrendDenominator(v) {
  const wc = v?.metrics?.words_checked;
  if (typeof wc === 'number') return { words: wc, approx: false };
  return { words: v?.words || 0, approx: true };
}

export const fehlerHeatmapMethods = {
  get fehlerHeatmapTypen() { return FEHLER_TYPEN; },
  get fehlerHeatmapClusters() { return FEHLER_CLUSTERS; },
  get fehlerHeatmapMinWords() { return HEATMAP_MIN_WORDS; },
  // Beginnt an dieser Spalte ein neues Cluster? (→ Trennlinie)
  fehlerHeatmapIsClusterStart(idx) { return FEHLER_CLUSTER_STARTS.has(idx); },

  // Memo-Helper (cards/card-memo.js); Reset über this._memos = {} im Lade-Pfad.
  ...memoMethods,

  async loadFehlerHeatmap() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    // Nur die jüngste Anfrage darf schreiben: Modus-Wechsel und Buchwechsel
    // können eine ältere, langsamere Antwort überholen lassen.
    const seq = ++this._fehlerHeatmapSeq;
    const current = () => seq === this._fehlerHeatmapSeq && isSelectedBook(bookId);
    this.fehlerHeatmapLoading = true;
    this.fehlerHeatmapStatus = '';
    this._memos = {};
    try {
      const mode = MODES.includes(this.fehlerHeatmapMode) ? this.fehlerHeatmapMode : 'open';
      const data = await fetchJson(`/history/fehler-heatmap/${bookId}?mode=${mode}`);
      if (!current()) return;
      this.fehlerHeatmapData = data;
    } catch (e) {
      if (!current()) return;
      console.error('[loadFehlerHeatmap]', e);
      this.fehlerHeatmapStatus = window.__app.t('common.errorColon') + escHtml(e.message || '');
    } finally {
      if (seq === this._fehlerHeatmapSeq) this.fehlerHeatmapLoading = false;
    }
  },

  async setFehlerHeatmapMode(mode) {
    if (!MODES.includes(mode)) return;
    if (this.fehlerHeatmapMode === mode) return;
    this.fehlerHeatmapMode = mode;
    this.activeFehlerDetailKey = null;
    await this.loadFehlerHeatmap();
    // Trend-Daten tragen alle drei Modi — kein Refetch, nur neu zeichnen.
    this.renderFehlerTrendChart();
  },

  // ── Fehlerdichte-Trend über die Fassungen ─────────────────────────────────
  async loadFehlerTrend() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) return;
    try {
      const data = await fetchJson(`/history/fehler-trend/${bookId}`);
      if (!isSelectedBook(bookId)) return;
      this.fehlerTrendData = data?.versions || [];
    } catch (e) {
      if (!isSelectedBook(bookId)) return;
      console.error('[loadFehlerTrend]', e);
      this.fehlerTrendData = [];
    }
    this.$nextTick(() => requestAnimationFrame(() => this.renderFehlerTrendChart()));
  },

  // Fassungen mit Lektorat-Kennzahl + gültigem Nenner — nur diese tragen einen
  // Dichte-Punkt. Reihenfolge aus dem Backend (seq aufsteigend).
  _fehlerTrendPoints() {
    return (this.fehlerTrendData || []).filter(v => v.metrics && fehlerTrendDenominator(v).words > 0);
  },

  // Trägt mindestens ein Punkt nur den Buchumfang als Nenner? → Hinweis unter dem Chart.
  fehlerTrendHasApprox() {
    return this._fehlerTrendPoints().some(v => fehlerTrendDenominator(v).approx);
  },

  // Genug Datenpunkte für einen sichtbaren Verlauf? Sonst Hinweis statt Chart.
  fehlerTrendHasData() {
    return this._fehlerTrendPoints().length >= 2;
  },

  // Fehler pro 1000 geprüfte Wörter für eine Fassung im aktuellen Modus.
  _fehlerTrendPer1k(v) {
    const total = v.metrics?.[this.fehlerHeatmapMode]?.total;
    const { words } = fehlerTrendDenominator(v);
    if (total == null || !(words > 0)) return null;
    return Math.round((total / words) * 1000 * 10) / 10;
  },

  async renderFehlerTrendChart() {
    const canvas = document.getElementById('fehler-trend-chart');
    if (!canvas) return;
    if (!this.fehlerTrendHasData()) { _destroyFehlerTrendChart(); return; }

    if (typeof window.Chart === 'undefined') {
      try { await loadChart(); }
      catch (e) {
        const ph = document.createElement('div');
        ph.className = 'muted-msg muted-msg--block';
        ph.textContent = e.message;
        canvas.replaceWith(ph);
        return;
      }
    }

    // Immer frisch aufbauen (Update-Pfad liest keine neuen Canvas-Dimensionen
    // nach einem display:none↔block-Wechsel — bliebe sonst leer).
    _destroyFehlerTrendChart();

    const points = this._fehlerTrendPoints();
    const tag = localeTag(Alpine.store('shell').uiLocale);
    const labels = points.map(v => v.label || window.__app.t('fehlerHeatmap.trend.versionLabel', { n: v.seq }));
    const data = points.map(v => this._fehlerTrendPer1k(v));
    const approx = points.map(v => fehlerTrendDenominator(v).approx);

    const accent = cssVar('--color-primary');
    const muted = cssVar('--color-muted');
    const gridLine = cssVar('--color-border');

    _ensureTrendThemeObserver(this);

    _trend.set(new window.Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: window.__app.t('fehlerHeatmap.trend.yLabel'),
          data,
          borderColor: accent,
          backgroundColor: accent + '12',
          borderWidth: 2,
          tension: 0.35,
          pointRadius: 4,
          pointHoverRadius: 6,
          // Näherungs-Punkte (Nenner = Buchumfang) hohl, ihre Strecken gestrichelt.
          pointBackgroundColor: approx.map(a => (a ? 'transparent' : accent)),
          pointBorderColor: accent,
          segment: {
            borderDash: (ctx) => (approx[ctx.p0DataIndex] || approx[ctx.p1DataIndex] ? [4, 4] : undefined),
          },
          fill: true,
          spanGaps: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => {
                const v = points[items[0]?.dataIndex];
                if (!v) return '';
                const when = v.created_at ? new Date(v.created_at).toLocaleDateString(tag, tzOpts({ day: '2-digit', month: '2-digit', year: '2-digit' })) : '';
                return when ? `${items[0].label} · ${when}` : items[0].label;
              },
              label: (ctx) => {
                const y = ctx.parsed.y;
                if (y == null) return '';
                return ` ${formatNumber(y, Alpine.store('shell').uiLocale, 1)} ${window.__app.t('fehlerHeatmap.trend.per1kUnit')}`;
              },
              afterLabel: (ctx) => (approx[ctx.dataIndex] ? ` ${window.__app.t('fehlerHeatmap.trend.approxPoint')}` : ''),
            },
          },
        },
        scales: {
          x: { grid: { color: gridLine }, ticks: { font: { size: 11 }, color: muted } },
          y: {
            grid: { color: gridLine },
            beginAtZero: true,
            ticks: {
              font: { size: 11 },
              color: muted,
              callback: (v) => formatNumber(v, Alpine.store('shell').uiLocale, 1),
            },
          },
        },
      },
    }));
  },

  fehlerHeatmapChapterName(ch) {
    return ch.chapter_name || window.__app.t('fehlerHeatmap.unassigned');
  },

  // Render-fertige Zeilen (buildFehlerRows). Memoized über den Datenstand und die
  // Anzeigesprache — ein neuer Ladevorgang tauscht die Datenreferenz.
  fehlerHeatmapRows() {
    const data = this.fehlerHeatmapData;
    const locale = Alpine.store('shell').uiLocale;
    return this._memo('rows', [data, locale], () => buildFehlerRows(data, FEHLER_TYPEN, locale));
  },

  fehlerHeatmapTotals() {
    const data = this.fehlerHeatmapData;
    const locale = Alpine.store('shell').uiLocale;
    return this._memo('totals', [data, locale], () => buildFehlerTotals(data, FEHLER_TYPEN, locale));
  },

  // Tooltip einer Zelle aus den vorbereiteten Parametern (Text = UI-String).
  fehlerHeatmapCellTooltip(cell) {
    const tip = cell?.tip;
    if (!tip) return window.__app.t('fehlerHeatmap.cellTooltipUnchecked');
    const t = window.__app.t;
    const base = tip.count > 0
      ? t('fehlerHeatmap.cellTooltip', { count: tip.count, pages: tip.pages, per1k: tip.per1k })
      : t('fehlerHeatmap.cellTooltipZero', { pages: tip.checkedPages });
    return tip.lowData ? `${base} · ${t('heatmap.lowData', { n: HEATMAP_MIN_WORDS })}` : base;
  },

  fehlerHeatmapTotalTooltip(total) {
    return window.__app.t('fehlerHeatmap.totalTooltip', { count: total.count, per1k: total.per1k });
  },

  toggleFehlerHeatmapDetail(cell) {
    if (!cell?.clickable) return;
    this.activeFehlerDetailKey = (this.activeFehlerDetailKey === cell.detailKey) ? null : cell.detailKey;
  },

  fehlerHeatmapActiveDetail() {
    const key = this.activeFehlerDetailKey;
    if (!key) return null;
    const sep = key.lastIndexOf(':');
    const chapterKey = key.slice(0, sep);
    const typ = key.slice(sep + 1);
    const pages = this.fehlerHeatmapData?.details?.[key] || [];
    const chapter = (this.fehlerHeatmapData?.chapters || []).find(c => fehlerChapterKey(c) === chapterKey);
    return {
      key,
      chapterKey,
      typ,
      chapterName: chapter ? this.fehlerHeatmapChapterName(chapter) : '',
      pages,
    };
  },

  async fehlerHeatmapJumpToPage(pageId) {
    const page = (Alpine.store('nav').pages || []).find(p => p.id === pageId);
    if (!page) return;
    window.__app.showFehlerHeatmapCard = false;
    this.activeFehlerDetailKey = null;
    await window.__app.selectPage(page);
    // Jüngsten Lektorat-Eintrag öffnen, damit die Findings direkt sichtbar sind.
    // Wenn gerade ein Check-Job läuft, ist pageHistory evtl. leer – dann nichts tun.
    const latest = (window.__app.pageHistory || [])[0];
    if (latest && window.__app.activeHistoryEntryId !== latest.id) {
      await window.__app.loadHistoryEntry(latest);
    }
  },

  async fehlerHeatmapJumpToChapter(ch) {
    if (!ch || ch.chapter_id == null) return;
    const root = window.__app;
    const chapterId = ch.chapter_id;
    const opts = root.kapitelReviewChapterOptions ? root.kapitelReviewChapterOptions() : [];
    this.activeFehlerDetailKey = null;
    if (opts.some(c => String(c.id) === String(chapterId))) {
      root.showFehlerHeatmapCard = false;
      await root.openKapitelReviewForChapter(chapterId);
      return;
    }
    const chapterNode = (Alpine.store('nav').tree || []).find(i => i.type === 'chapter' && String(i.id) === String(chapterId));
    const firstPage = chapterNode?.pages?.[0];
    if (firstPage) {
      root.showFehlerHeatmapCard = false;
      await root.selectPage(firstPage);
    }
  },
};
