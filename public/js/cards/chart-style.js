// Gemeinsamer Zeitreihen-Look für Chart.js-Karten: ruhiges Raster (nur
// horizontale Haarlinien), Punkte erst beim Hover, Verlaufsfüllung unter der
// Kurve, Fadenkreuz am aktiven Index, Tooltip in den Flächen-Tokens der App.
//
// Ein Canvas löst keine CSS-Custom-Properties auf: alle Farben kommen über
// `chartPalette()` zur Render-Zeit, der Theme-Wechsel baut den Chart neu
// (chart-holder.js#ensureThemeRedraw).

import { dateTimeFormat } from '../utils.js';
import { cssVar } from './chart-holder.js';

/** Farb-Token der App für einen Chart-Render. */
export function chartPalette() {
  return {
    primary: cssVar('--color-primary'),
    accent:  cssVar('--color-accent'),
    success: cssVar('--color-success'),
    muted:   cssVar('--color-muted'),
    text:    cssVar('--color-text'),
    surface: cssVar('--color-surface'),
    border:  cssVar('--color-border'),
    font:    cssVar('--font-sans') || 'system-ui, sans-serif',
  };
}

/** Hex-Farbe (#rgb/#rrggbb) mit Deckkraft; andere Formate unverändert. */
export function withAlpha(color, alpha) {
  let hex = String(color || '').trim();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return color;
  if (hex.length === 4) hex = '#' + [...hex.slice(1)].map(c => c + c).join('');
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Scriptable `backgroundColor`: Verlauf von der Kurve nach unten ins Transparente. */
export function areaGradient(color, top = 0.22, bottom = 0) {
  return (ctx) => {
    const { chart } = ctx;
    const area = chart.chartArea;
    if (!area) return withAlpha(color, top / 2);
    const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, withAlpha(color, top));
    g.addColorStop(1, withAlpha(color, bottom));
    return g;
  };
}

/** Senkrechte Linie am aktiven Tooltip-Index. Per Chart registrieren (`plugins: [...]`). */
export function crosshairPlugin(color) {
  return {
    id: 'swCrosshair',
    afterDatasetsDraw(chart) {
      const active = chart.tooltip?.getActiveElements?.() || [];
      if (!active.length) return;
      const x = active[0].element.x;
      const { top, bottom } = chart.chartArea;
      const c = chart.ctx;
      c.save();
      c.beginPath();
      c.moveTo(x, top);
      c.lineTo(x, bottom);
      c.lineWidth = 1;
      c.strokeStyle = color;
      c.setLineDash([3, 3]);
      c.stroke();
      c.restore();
    },
  };
}

// Ein Kalenderdatum ist keine Uhrzeit: formatiert wird der UTC-Mittag in
// timeZone 'UTC', damit keine Zeitzone (weder Browser noch App) den Tag verschiebt.
function _utcNoon(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** Kurzes Achsenlabel eines ISO-Kalendertags („3. Apr.“); mit Jahr, wenn die Reihe Jahre überspannt. */
export function calendarAxisLabel(iso, uiLocale, withYear = false) {
  const opts = { day: 'numeric', month: 'short', timeZone: 'UTC' };
  if (withYear) opts.year = '2-digit';
  return dateTimeFormat(uiLocale, opts).format(_utcNoon(iso));
}

/** Volles Tooltip-Datum eines ISO-Kalendertags („Fr., 3. Apr. 2026“). */
export function calendarTooltipLabel(iso, uiLocale) {
  return dateTimeFormat(uiLocale, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(_utcNoon(iso));
}

/** Kompakte Achsenzahl (12 Tsd., 1,2 Mio.) für grosse Werte, sonst `fallback`. */
export function compactTick(tag, fallback) {
  const compact = new Intl.NumberFormat(tag, { notation: 'compact', maximumFractionDigits: 1 });
  return (v) => (Math.abs(v) >= 10000 ? compact.format(v) : fallback(v));
}

// Kategoriale Serienfarben (Bücher, Kapitel, Modelle) — mittlere Sättigung,
// lesbar auf Hell und Dunkel. Jenseits der Liste: goldener Winkel (seriesColor).
export const SERIES_COLORS = [
  '#5b6ee1', '#e08a3c', '#3fae6e', '#c45fa0',
  '#c9a93a', '#46a7bd', '#d05a5a', '#8f7ae0',
  '#6aaf4e', '#b06ad0', '#d98f5e', '#4e8fd0',
];

function _hslHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Serienfarbe Nr. `ix`; stabil, unbegrenzt viele. */
export function seriesColor(ix) {
  if (ix < SERIES_COLORS.length) return SERIES_COLORS[ix];
  const hue = ((ix - SERIES_COLORS.length) * 137.508 + 20) % 360;
  return _hslHex(hue, 0.55, 0.52);
}

// Linien zeigen ihre Strichfarbe, Balken ihre Füllung (deren Rand ist die Fuge
// in Flächenfarbe und taugt nicht als Legendenfarbe).
function _legendColor(ds, chartType) {
  const pick = (c) => (Array.isArray(c) ? c.find(Boolean) : c);
  if ((ds.type || chartType) === 'bar') return pick(ds.hoverBackgroundColor) || pick(ds.backgroundColor);
  return typeof ds.borderColor === 'string' ? ds.borderColor : pick(ds.backgroundColor);
}

function _legendLabels(chart) {
  const base = window.Chart.defaults.plugins.legend.labels.generateLabels(chart);
  return base.map((item) => {
    const ds = chart.data.datasets[item.datasetIndex] || {};
    const color = _legendColor(ds, chart.config.type);
    const dashed = Array.isArray(ds.borderDash) && ds.borderDash.length > 0;
    return {
      ...item,
      pointStyle: dashed ? 'line' : 'rectRounded',
      fillStyle: color,
      strokeStyle: color,
      lineWidth: dashed ? 2 : 0,
    };
  });
}

const _font = (p, size = 11) => ({ family: p.font, size });

/**
 * Legende unten links. `kind: 'series'` — je Dataset ein Eintrag (gestrichelt →
 * Linie, sonst Farbfeld); `kind: 'items'` — Chart.js' eigene Einträge (Ring je
 * Datenpunkt, Streu je Gruppe) nur im App-Stil, als Punkt.
 */
export function chartLegend(p, { display = true, kind = 'series', position = 'bottom' } = {}) {
  const labels = { color: p.muted, font: _font(p), padding: 14, usePointStyle: true, boxWidth: 8, boxHeight: 8 };
  if (kind === 'series') {
    Object.assign(labels, {
      boxWidth: 18,
      // Reihenfolge wie die Datasets (Chart.js sortiert sonst nach Zeichen-`order`).
      sort: (a, b) => a.datasetIndex - b.datasetIndex,
      generateLabels: _legendLabels,
    });
  } else {
    labels.pointStyle = 'circle';
  }
  return { display, position, align: 'start', labels };
}

/** Tooltip in den Flächen-Tokens der App. */
export function chartTooltip(p) {
  return {
    backgroundColor: p.surface,
    borderColor: p.border,
    borderWidth: 1,
    titleColor: p.muted,
    bodyColor: p.text,
    footerColor: p.muted,
    titleFont: { family: p.font, size: 11, weight: 'normal' },
    bodyFont: { family: p.font, size: 12, weight: '600' },
    footerFont: { family: p.font, size: 11, weight: 'normal' },
    padding: 10,
    cornerRadius: 8,
    caretSize: 0,
    displayColors: true,
    usePointStyle: true,
    boxWidth: 8,
    boxHeight: 8,
    boxPadding: 4,
    // Hauptreihe vor den Bezugslinien, unabhängig von der Zeichen-`order`.
    itemSort: (a, b) => a.datasetIndex - b.datasetIndex,
  };
}

/** Kategorie-/Zeitachse: kein Raster, gerade Labels, ausgedünnt. */
export function categoryAxis(p, extra = {}) {
  return {
    grid: { display: false },
    border: { color: p.border },
    ...extra,
    ticks: {
      color: p.muted, font: _font(p),
      maxRotation: 0, autoSkip: true, autoSkipPadding: 24, maxTicksLimit: 8,
      ...(extra.ticks || {}),
    },
  };
}

/** Werteachse: gestrichelte Haarlinien, kein Achsenstrich, wenige Ticks. */
export function valueAxis(p, extra = {}) {
  return {
    grid: { color: p.border, drawTicks: false },
    border: { display: false, dash: [3, 4] },
    ...extra,
    ticks: { color: p.muted, font: _font(p), padding: 8, maxTicksLimit: 6, ...(extra.ticks || {}) },
    title: extra.title ? { color: p.muted, font: _font(p), ...extra.title } : { display: false },
  };
}

/** Gemeinsamer Rahmen: responsive, Index-Hover, App-Legende und -Tooltip. */
export function chartOptions(p, { legend = false, legendKind = 'series', legendPosition = 'bottom' } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 4, right: 4 } },
    plugins: {
      legend: chartLegend(p, { display: legend, kind: legendKind, position: legendPosition }),
      tooltip: chartTooltip(p),
    },
  };
}

/** Basis-Optionen einer Zeitreihe; Aufrufer ergänzt `ticks.callback` und Tooltip-Callbacks. */
export function timeSeriesOptions(p, opts = {}) {
  return { ...chartOptions(p, opts), scales: { x: categoryAxis(p), y: valueAxis(p) } };
}

/**
 * Linien-Dataset im App-Stil. `area: true` füllt mit Verlauf bis zur Achse;
 * Punkte nur bei wenigen Messwerten (`sparse`), sonst erst beim Hover.
 */
export function lineDataset(p, color, { area = false, sparse = false, ...rest } = {}) {
  return {
    type: 'line',
    borderColor: color,
    backgroundColor: area ? areaGradient(color) : color,
    borderWidth: 2,
    cubicInterpolationMode: 'monotone',
    pointRadius: sparse ? 3 : 0,
    pointHoverRadius: 5,
    pointBackgroundColor: color,
    pointBorderColor: p.surface,
    pointBorderWidth: sparse ? 1.5 : 0,
    pointHoverBorderWidth: 2,
    fill: area ? 'start' : false,
    ...rest,
  };
}

/** Balken-Dataset im App-Stil: abgerundet, schmal genug, Hover in voller Farbe. */
export function barDataset(p, color, { stacked = false, ...rest } = {}) {
  const soft = Array.isArray(color) ? color.map(c => withAlpha(c, 0.85)) : withAlpha(color, 0.85);
  return {
    type: 'bar',
    backgroundColor: soft,
    hoverBackgroundColor: color,
    borderRadius: 3,
    borderSkipped: false,
    // Gestapelte Segmente durch eine Fuge in Flächenfarbe trennen.
    borderWidth: stacked ? 1 : 0,
    borderColor: p.surface,
    maxBarThickness: 22,
    categoryPercentage: 0.8,
    barPercentage: 0.9,
    ...rest,
  };
}

/** Gestrichelte Bezugslinie (Ø, Ziel, Trend) ohne Punkte. */
export function refLineDataset(color, { dash = [6, 4], ...rest } = {}) {
  return {
    type: 'line',
    borderColor: color,
    borderWidth: 1.5,
    borderDash: dash,
    pointRadius: 0,
    pointHoverRadius: 0,
    fill: false,
    spanGaps: true,
    ...rest,
  };
}
