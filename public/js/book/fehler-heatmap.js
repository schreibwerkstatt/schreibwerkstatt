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
import { loadToken } from '../cards/book-guard.js';
import { tFetchError } from '../i18n.js';
import { highlightOccurrenceOnPage } from './passage-highlight.js';
import { createChartHolder } from '../cards/chart-holder.js';
import { chartPalette, crosshairPlugin, lineDataset, timeSeriesOptions, withAlpha } from '../cards/chart-style.js';
import { memoMethods } from '../cards/card-memo.js';
import { isChapterItem } from './tree/chapter-items.js';


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
  { key: 'sprache',    typen: ['rechtschreibung', 'grammatik', 'konjunktiv', 'dialogformat'] },
  { key: 'wort',       typen: ['wiederholung', 'schwaches_verb', 'fuellwort', 'filterwort'] },
  { key: 'stil',       typen: ['stil', 'satzbau', 'pleonasmus', 'klischee', 'ki_geruch', 'passiv'] },
  { key: 'erzaehlung', typen: ['show_vs_tell', 'perspektivbruch', 'tempuswechsel', 'soziolekt'] },
  { key: 'fach',       typen: ['unbelegt', 'begriffsinkonsistenz', 'autorenform', 'hedging'] },
  { key: 'journal',    typen: ['zuschreibung', 'wertung', 'amtsdeutsch'] },
  { key: 'welt',       typen: ['namenskonsistenz', 'figurenmerkmal', 'schauplatzmerkmal', 'anrede', 'weltfakt'] },
];
const FEHLER_TYPEN = FEHLER_CLUSTERS.flatMap(c => c.typen);

// Spalte «Sonstige»: bündelt Befund-Typen ohne eigene Spalte (umbenannt,
// entfernt, aus einem Import). Erscheint nur, wenn es solche Befunde gibt —
// sonst verschwänden sie still, während Trend und Summen sie mitzählen.
export const FEHLER_OTHER = 'sonstige';
const FEHLER_CLUSTERS_WITH_OTHER = [...FEHLER_CLUSTERS, { key: 'other', typen: [FEHLER_OTHER] }];
const FEHLER_TYPEN_WITH_OTHER = [...FEHLER_TYPEN, FEHLER_OTHER];
const KNOWN_TYPEN = new Set(FEHLER_TYPEN);

// Spalten-Indizes der jeweils ersten Spalte eines Clusters (fuer Trennlinien).
// Das erste Cluster startet bei 0 und faellt raus — links aussen keine Linie.
// Modul-Konstante, kein Getter: das Template fragt sie einmal PRO ZELLE ab
// (26 Typen x N Kapiteln), und ein Getter haette dabei jedes Mal zwei Arrays
// gebaut. Set statt Array, weil der Zugriff ein Enthaltensein-Test ist.
// Enthält auch den Start der «Sonstige»-Spalte; ohne sie gibt es den Index nicht.
const FEHLER_CLUSTER_STARTS = new Set(FEHLER_CLUSTERS_WITH_OTHER.reduce((acc, c) => {
  acc.push(acc.at(-1) + c.typen.length);
  return acc;
}, [0]).slice(0, -1).slice(1));

/** Faltet Typen ohne eigene Spalte in den Bucket `FEHLER_OTHER` (Matrix, Summen,
 *  Detail-Liste). Pure; liefert die Antwort unverändert zurück, wenn es keine
 *  solchen Typen gibt. Dichten addieren sich (gleicher Nenner je Kapitel), die
 *  Abschnittszahl kommt aus den Detail-Listen (eindeutige page_id). */
export function withOtherBucket(data, known = KNOWN_TYPEN) {
  if (!data?.matrix) return data;
  const isOther = (typ) => typ !== FEHLER_OTHER && !known.has(typ);
  if (!Object.keys(data.totals || {}).some(isOther)) return data;

  const matrix = {};
  const details = { ...(data.details || {}) };
  for (const [key, row] of Object.entries(data.matrix)) {
    const out = {};
    let count = 0, per1k = 0;
    const pages = new Map(); // page_id -> Detail-Eintrag (zusammengeführt)
    for (const [typ, cell] of Object.entries(row)) {
      if (!isOther(typ)) { out[typ] = cell; continue; }
      count += cell.count || 0;
      per1k += cell.per1k || 0;
      for (const d of details[`${key}:${typ}`] || []) {
        const prev = pages.get(d.page_id);
        if (prev) {
          prev.count += d.count;
          prev.samples = [...prev.samples, ...(d.samples || [])];
        } else {
          pages.set(d.page_id, { ...d, samples: [...(d.samples || [])] });
        }
      }
      delete details[`${key}:${typ}`];
    }
    if (count > 0) {
      out[FEHLER_OTHER] = { count, per1k, pages: pages.size };
      details[`${key}:${FEHLER_OTHER}`] = [...pages.values()].sort((a, b) => b.count - a.count);
    }
    matrix[key] = out;
  }
  const totals = {};
  for (const [typ, n] of Object.entries(data.totals || {})) {
    const k = isOther(typ) ? FEHLER_OTHER : typ;
    totals[k] = (totals[k] || 0) + n;
  }
  return { ...data, matrix, totals, details };
}

const MODES = ['open', 'applied', 'all'];
const UNCAT = '__uncat__';

/** Zeilen-Schlüssel eines Kapitels — derselbe wie in `matrix`/`details` der Antwort. */
export function fehlerChapterKey(ch) {
  return ch.chapter_id == null ? UNCAT : String(ch.chapter_id);
}

function _coveragePct(ch) {
  return ch.pages_total ? Math.round((ch.pages_checked / ch.pages_total) * 100) : 0;
}

// Abdeckung nach Umfang (0..1): heutige Wörter der geprüften Abschnitte am
// Kapitelumfang. Steuert die Blässe — ein ungeprüfter Kurz-Abschnitt neben
// einem langen geprüften soll die Farbe nicht halbieren. Ohne `words_covered`
// (ältere Antwort) oder ohne Umfang: Anteil der Abschnitte.
function _coverageWords(ch) {
  if (typeof ch.words_covered === 'number' && ch.words > 0) return Math.min(1, ch.words_covered / ch.words);
  return ch.pages_total ? ch.pages_checked / ch.pages_total : 0;
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
 *     Hintergrund, nicht auf die Zahl), nach Anteil der geprüften WÖRTER.
 *
 *  `depthOf(chapter_id)` liefert die Gliederungstiefe (1 = Kapitel, 2 =
 *  Unterkapitel …) für die Einrückung; ohne Funktion bleibt alles auf 1. */
export function buildFehlerRows(data, typen, uiLocale, depthOf = null) {
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
    const cov = _coverageWords(ch);
    const opacity = cov < 1 ? 0.5 + (cov / 2) : 1;
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
        cls: `heatmap-cell--${kind}${clickable ? ' heatmap-cell--clickable' : ''}`,
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
    const depth = ch.chapter_id != null && depthOf ? Math.max(1, Number(depthOf(ch.chapter_id)) || 1) : 1;
    return {
      key,
      chapter: ch,
      depth,
      // Einrückung als CSS-Variable (keine Inline-Styles im Markup).
      indentVars: { '--heatmap-depth': String(depth - 1) },
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
  // Spalten + Cluster als STATE, kein Getter: die Methoden werden per Spread in
  // Alpine.data kopiert, und der Spread wertet Getter einmal aus — ein
  // datenabhängiger Getter fröre auf dem Stand ohne Daten ein. Mit Spalte
  // «Sonstige» nur, wenn die geladene Antwort solche Befunde trägt
  // (_applyFehlerColumns im Lade-Pfad). Konstante Arrays, keine Kopie pro Render.
  fehlerHeatmapTypen: FEHLER_TYPEN,
  fehlerHeatmapClusters: FEHLER_CLUSTERS,
  get fehlerHeatmapOther() { return FEHLER_OTHER; },
  _applyFehlerColumns(data) {
    const other = (data?.totals?.[FEHLER_OTHER] || 0) > 0;
    this.fehlerHeatmapTypen = other ? FEHLER_TYPEN_WITH_OTHER : FEHLER_TYPEN;
    this.fehlerHeatmapClusters = other ? FEHLER_CLUSTERS_WITH_OTHER : FEHLER_CLUSTERS;
  },
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
    const current = loadToken(this, '_fehlerHeatmapSeq', bookId);
    this.fehlerHeatmapLoading = true;
    this.fehlerHeatmapStatus = '';
    this._memos = {};
    try {
      const mode = MODES.includes(this.fehlerHeatmapMode) ? this.fehlerHeatmapMode : 'open';
      const data = await fetchJson(`/history/fehler-heatmap/${bookId}?mode=${mode}`);
      if (!current()) return;
      const shaped = withOtherBucket(data);
      this._applyFehlerColumns(shaped);
      this.fehlerHeatmapData = shaped;
    } catch (e) {
      if (!current()) return;
      console.error('[loadFehlerHeatmap]', e);
      this.fehlerHeatmapStatus = window.__app.t('common.errorColon') + escHtml(tFetchError(e));
    } finally {
      if (current.latest()) this.fehlerHeatmapLoading = false;
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
    // Wie loadFehlerHeatmap: nur die jüngste Anfrage schreibt (schneller Buchwechsel).
    const current = loadToken(this, '_fehlerTrendSeq', bookId);
    try {
      const data = await fetchJson(`/history/fehler-trend/${bookId}`);
      if (!current()) return;
      this.fehlerTrendData = data?.versions || [];
    } catch (e) {
      if (!current()) return;
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

    const pal = chartPalette();
    const color = pal.primary;

    _ensureTrendThemeObserver(this);

    const options = timeSeriesOptions(pal);
    options.plugins.tooltip.callbacks = {
      title: (items) => {
        const v = points[items[0]?.dataIndex];
        if (!v) return '';
        const when = v.created_at ? new Date(v.created_at).toLocaleDateString(tag, tzOpts({ day: 'numeric', month: 'short', year: 'numeric' })) : '';
        return when ? `${items[0].label} · ${when}` : items[0].label;
      },
      label: (ctx) => {
        const y = ctx.parsed.y;
        if (y == null) return '';
        return ` ${formatNumber(y, Alpine.store('shell').uiLocale, 1)} ${window.__app.t('fehlerHeatmap.trend.per1kUnit')}`;
      },
      afterLabel: (ctx) => (approx[ctx.dataIndex] ? ` ${window.__app.t('fehlerHeatmap.trend.approxPoint')}` : ''),
    };
    options.scales.y.beginAtZero = true;
    options.scales.y.ticks.callback = (v) => formatNumber(v, Alpine.store('shell').uiLocale, 1);

    // Fassungen sind wenige, jede zählt → Punkte immer sichtbar.
    _trend.set(new window.Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [lineDataset(pal, color, {
          label: window.__app.t('fehlerHeatmap.trend.yLabel'),
          data,
          area: true,
          sparse: true,
          // Näherungs-Punkte (Nenner = Buchumfang) hohl, ihre Strecken gestrichelt.
          pointBackgroundColor: approx.map(a => (a ? pal.surface : color)),
          pointBorderColor: approx.map(a => (a ? color : pal.surface)),
          segment: {
            borderDash: (ctx) => (approx[ctx.p0DataIndex] || approx[ctx.p1DataIndex] ? [4, 4] : undefined),
          },
          spanGaps: true,
        })],
      },
      options,
      plugins: [crosshairPlugin(withAlpha(pal.muted, 0.5))],
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
    const tree = Alpine.store('nav').tree;
    return this._memo('rows', [data, locale, tree], () => {
      const depth = new Map((tree || []).filter(i => isChapterItem(i)).map(i => [String(i.id), i.depth]));
      return buildFehlerRows(data, this.fehlerHeatmapTypen, locale, (id) => depth.get(String(id)));
    });
  },

  fehlerHeatmapTotals() {
    const data = this.fehlerHeatmapData;
    const locale = Alpine.store('shell').uiLocale;
    return this._memo('totals', [data, locale], () => buildFehlerTotals(data, this.fehlerHeatmapTypen, locale));
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

  // Sprung in den Abschnitt; mit `snippet` (Original eines Befunds) an diese
  // Stelle statt an den Anfang. Öffnet den jüngsten eigenen Lektorat-Eintrag,
  // damit die Befunde markiert sind — aber nur, wenn die Auswahl wirklich auf
  // diesem Abschnitt gelandet ist: ein überholtes selectPage liesse sonst den
  // Verlauf des vorigen Abschnitts stehen.
  async fehlerHeatmapJumpToPage(pageId, snippet = '') {
    const root = window.__app;
    const page = (Alpine.store('nav').pages || []).find(p => String(p.id) === String(pageId));
    if (!page) return;
    root.showFehlerHeatmapCard = false;
    this.activeFehlerDetailKey = null;
    await root.selectPage(page);
    if (String(root.currentPage?.id) !== String(page.id)) return;
    const latest = (root.pageHistory || [])[0];
    if (latest && root.activeHistoryEntryId !== latest.id) {
      await root.loadHistoryEntry(latest);
    }
    if (snippet) highlightOccurrenceOnPage(snippet, { pageId: page.id });
  },

  // Gleiches Sprungziel wie jede Kapitel-Referenz (kapitel-review.js#openChapterById):
  // Kapitelbewertung, sonst erster Abschnitt — auch in Unterkapiteln.
  async fehlerHeatmapJumpToChapter(ch) {
    if (!ch || ch.chapter_id == null) return;
    this.activeFehlerDetailKey = null;
    window.__app.showFehlerHeatmapCard = false;
    await window.__app.openChapterById(ch.chapter_id);
  },
};
