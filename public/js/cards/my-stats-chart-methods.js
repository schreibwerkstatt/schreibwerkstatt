// Chart-Rendering der Karte „Meine Statistik" — in myStatsCard gespreadet
// (`...myStatsChartMethods`). Ausgelagert, damit my-stats-card.js unter dem
// 600-LOC-Cap bleibt. Zugriff auf Card-State via `this` (Spread teilt den
// Alpine-Scope): this.myStatsMetric, this.myStatsHistory, this.myStatsWindow(), …
//
// Chart.js-Instanz + Theme-Observer liegen bewusst als Modul-State AUSSERHALB
// von Alpine: der Reaktivitaets-Proxy beschaedigt die Chart-Instanz (analog
// bookstats.js). Sie sind darum an dieses Modul gebunden und werden nur ueber
// die hier exportierten Methoden angefasst.
import { loadChart } from '../lazy-libs.js';
import { localeTag, localIsoDate, dateTimeFormat } from '../utils.js';
import { createChartHolder, cssVar } from './chart-holder.js';
import { bucketizeIso, bucketRange, aggregateByBucket } from './my-stats-compute.js';


// Chart-Metriken: content aus book_stats_history (Summe pro Tag), writing aus
// writing_time. Label-Keys werden zur Render-Zeit via t() aufgeloest (Locale-live).
// Die Zeit-Metriken tragen keine Einheit im Namen — die haengt an der
// Granularitaet (min/Tag, min/Woche, min/Monat) und kommt aus TIME_UNIT_KEYS.
const METRIC_KEYS = {
  chars:         'mystats.metric.chars',
  normseiten:    'mystats.metric.normseiten',
  words:         'mystats.metric.words',
  unique_words:  'mystats.metric.uniqueWords',
  page_count:    'mystats.metric.pages',
  chapter_count: 'mystats.metric.chapters',
  writing:       'mystats.metric.writing',
  lektorat:      'mystats.metric.lektorat',
};

// Farbpalette fuer Pro-Buch-Linien — mittlere Saettigung, lesbar auf Light+Dark.
// Auch von der Kategorie-Kachel der Karte genutzt, darum exportiert.
export const BOOK_COLORS = [
  '#5b6ee1', '#e08a3c', '#3fae6e', '#c45fa0',
  '#c9a93a', '#46a7bd', '#d05a5a', '#8f7ae0',
  '#6aaf4e', '#b06ad0', '#d98f5e', '#4e8fd0',
];

const TIME_UNIT_KEYS = {
  day:   'mystats.unit.minPerDay',
  week:  'mystats.unit.minPerWeek',
  month: 'mystats.unit.minPerMonth',
};

const _holder = createChartHolder();

// Achsen-Label eines Bucket-Schluessels (ISO-Datum). Ein Kalenderdatum ist
// keine Uhrzeit: formatiert wird der UTC-Mittag in timeZone 'UTC', damit keine
// Zeitzone (weder Browser noch App) das Datum um einen Tag verschiebt.
function bucketLabel(iso, gran, uiLocale) {
  const [y, m, d] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d, 12));
  const opts = gran === 'month'
    ? { month: 'short', year: '2-digit', timeZone: 'UTC' }
    : { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'UTC' };
  return dateTimeFormat(uiLocale, opts).format(at);
}

export const myStatsChartMethods = {
  // Vom destroy() der Karte gerufen: Modul-State freigeben, sonst ueberlebt der
  // Observer das Unmount und rendert in ein totes Canvas.
  _disconnectMyStatsThemeObserver() {
    _holder.disconnect();
  },

  _destroyChart() {
    _holder.destroy();
  },

  _ensureThemeObserver() {
    _holder.ensureThemeRedraw(() => {
      if (!window.__app.showMyStatsCard) return;
      _holder.destroy();
      this.renderMyStatsChart();
    });
  },

  // Buchname aus der bereits geladenen Root-Buchliste (id → name).
  _bookName(bookId) {
    const b = (Alpine.store('nav').books || []).find(x => String(x.id) === String(bookId));
    return b?.name || (window.__app.t('mystats.unknownBook') + ' ' + bookId);
  },

  // Einheit der Zeit-Metriken je Granularitaet („min/Tag" …); kumuliert: „min".
  myStatsTimeUnit() {
    const t = window.__app.t;
    if (this.myStatsCumulative) return t('mystats.unit.min');
    return t(TIME_UNIT_KEYS[this.myStatsChartGran] || TIME_UNIT_KEYS.day);
  },

  // Zeit-Metrik gewaehlt (Schreib-/Lektoratszeit)?
  myStatsIsTimeMetric() {
    return this.myStatsMetric === 'writing' || this.myStatsMetric === 'lektorat';
  },

  // Zugaenglicher Name des Diagramms: Kennzahl + Zeitraum (+ Einheit).
  myStatsChartAria() {
    const t = window.__app.t;
    const metric = t(METRIC_KEYS[this.myStatsMetric] || this.myStatsMetric)
      + (this.myStatsIsTimeMetric() ? ' (' + this.myStatsTimeUnit() + ')' : '');
    const w = this.myStatsWindow();
    const range = w.active
      ? t('mystats.chart.ariaRange', { from: w.from ? this.myStatsDateLabel(w.from) : '…', to: w.to ? this.myStatsDateLabel(w.to) : '…' })
      : t('mystats.chart.ariaAll');
    return t('mystats.chart.aria', { metric, range });
  },

  async renderMyStatsChart() {
    const canvas = document.getElementById('my-stats-chart');
    if (!canvas) return;
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
    // Immer frisch aufbauen (Update-Pfad liest keine neuen Canvas-Dimensionen).
    _holder.destroy();

    const metric = this.myStatsMetric;
    // Zeit-Metriken (Schreib- bzw. Lektoratszeit) sind Tages-Deltas in Sekunden;
    // Inhalts-Metriken sind kumulative book_stats_history-Snapshots.
    const isTime = this.myStatsIsTimeMetric();
    const timeSrc = metric === 'lektorat' ? this.myStatsLektorat : this.myStatsWriting;
    const byBook = this.myStatsChartMode === 'byBook';
    const cumulative = this.myStatsCumulative && isTime;

    // Leerzustand: ohne jede Snapshot-Historie (Buecher da, Nacht-Sync noch nicht
    // gelaufen) ein eigener Hinweis, sonst „keine Daten im Zeitraum".
    if (!isTime && !this.myStatsHistory.length) { this.myStatsChartEmpty = 'noHistory'; return; }

    // Quelle vereinheitlichen auf { book_id, date, raw }.
    const src = isTime ? timeSrc : this.myStatsHistory;
    let rows = src.map(r => ({ book_id: r.book_id, date: r.recorded_at || r.date, raw: r }));
    const win = this.myStatsWindow();
    if (win.from) rows = rows.filter(r => r.date >= win.from);
    if (win.to)   rows = rows.filter(r => r.date <= win.to);
    const hasValue = isTime ? rows.some(r => (Number(r.raw.seconds) || 0) > 0) : rows.length > 0;
    if (!hasValue) { this.myStatsChartEmpty = 'noData'; return; }
    this.myStatsChartEmpty = '';

    // Nur bis zum letzten vollständigen Sync zeigen: book_stats_history bekommt
    // pro Buch eine Tageszeile vom Nacht-Cron. Ein manueller Einzelbuch-Sync
    // mitten am Tag (oder ein noch ausstehender Nachtlauf) erzeugt sonst einen
    // Teil-Tages-Punkt mit weniger Büchern als der Vortag — als künstlicher
    // Einbruch sichtbar. Darum jüngste Tage abschneiden, solange ihre Buch-Zahl
    // unter der des Vortags liegt. Nur für Content-Historie.
    if (!isTime) {
      const allDates = [...new Set(rows.map(r => r.date))].sort();
      const booksOn = new Map();
      for (const r of rows) {
        if (!booksOn.has(r.date)) booksOn.set(r.date, new Set());
        booksOn.get(r.date).add(r.book_id);
      }
      let last = allDates.length - 1;
      while (last > 0 && booksOn.get(allDates[last]).size < booksOn.get(allDates[last - 1]).size) last--;
      const lastDate = allDates[last];
      rows = rows.filter(r => r.date <= lastDate);
    }

    const valOf = (raw) => {
      if (metric === 'normseiten') return Math.round(((Number(raw.chars) || 0) / 1500) * 10) / 10;
      if (isTime)                 return Math.round((Number(raw.seconds) || 0) / 60);
      return Number(raw[metric]) || 0;
    };

    // Zeitachsen-Granularitaet: Tag/Woche/Monat. Schreibzeit-Tageswerte werden
    // im Bucket summiert ('sum'); Inhalts-Snapshots (kumulative Groessen) nehmen
    // den juengsten Tageswert je Bucket ('last').
    const gran = this.myStatsChartGran;
    const aggMode = isTime ? 'sum' : 'last';

    // X-Achse. Zeit-Metriken: lueckenlose Kalender-Buckets vom Fensteranfang
    // (ohne Fenster: erster Datentag) bis Fensterende bzw. heute — ein Tag ohne
    // Schreibzeit ist eine 0, keine Luecke, die die Achse zusammenschiebt.
    // Inhalts-Metriken: die Snapshot-Tage selbst (Linie verbindet Bestaende).
    const today = localIsoDate();
    let buckets;
    if (isTime) {
      const first = rows.reduce((m, r) => (!m || r.date < m ? r.date : m), null);
      const to = win.to && win.to < today ? win.to : today;
      buckets = bucketRange(win.from || first, to, gran);
    } else {
      buckets = [...new Set(rows.map(r => bucketizeIso(r.date, gran)))].sort();
    }

    const uiLocale = Alpine.store('shell').uiLocale;
    const tag = localeTag(uiLocale);
    const labels = buckets.map(b => bucketLabel(b, gran, uiLocale));

    const unit = isTime ? this.myStatsTimeUnit() : '';
    const metricLabel = window.__app.t(METRIC_KEYS[metric] || metric) + (unit ? ` (${unit})` : '');
    const isDecimal = metric === 'normseiten';
    const fmt = v => (v == null) ? '' : (isDecimal
      ? v.toLocaleString(tag, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
      : Math.round(v).toLocaleString(tag));

    const primary  = cssVar('--color-primary');
    const success  = cssVar('--color-success');
    const muted    = cssVar('--color-muted');
    const gridLine = cssVar('--color-border');

    // Zeit-Metriken taeglich als Balken (ein Tageswert ist eine Menge, kein
    // Verlauf); kumuliert als Linie. Inhalts-Metriken immer Linie.
    const asBars = isTime && !cumulative;
    const accumulate = (series) => { let acc = 0; return series.map(v => (acc += (v || 0))); };

    let datasets;
    if (byBook) {
      // Eine Reihe pro Buch (Reihenfolge nach erstem Auftreten = stabile Farbe).
      const order = [];
      const perBook = new Map(); // book_id → [{ date, value }]
      for (const r of rows) {
        if (!perBook.has(r.book_id)) { perBook.set(r.book_id, []); order.push(r.book_id); }
        perBook.get(r.book_id).push({ date: r.date, value: valOf(r.raw) });
      }
      datasets = order.map((bid, i) => {
        const color = BOOK_COLORS[i % BOOK_COLORS.length];
        const bmap = new Map(aggregateByBucket(perBook.get(bid), gran, aggMode).map(x => [x.bucket, x.value]));
        let data = buckets.map(b => bmap.has(b) ? bmap.get(b) : (isTime ? 0 : null));
        if (cumulative) data = accumulate(data);
        return asBars
          ? { label: this._bookName(bid), data, backgroundColor: color, borderWidth: 0, stack: 'books' }
          : {
            label: this._bookName(bid),
            data,
            borderColor: color,
            backgroundColor: color,
            pointBackgroundColor: color,
            borderWidth: 2,
            tension: 0.3,
            pointRadius: 2,
            pointHoverRadius: 5,
            fill: false,
            spanGaps: true,
          };
      });
    } else {
      // Gesamt: erst Summe pro Tag über alle Bücher, dann auf Buckets verdichten.
      const totalByDate = new Map();
      for (const r of rows) totalByDate.set(r.date, (totalByDate.get(r.date) || 0) + valOf(r.raw));
      const points = [...totalByDate.entries()].map(([date, value]) => ({ date, value }));
      const bmap = new Map(aggregateByBucket(points, gran, aggMode).map(x => [x.bucket, x.value]));
      let series = buckets.map(b => bmap.has(b) ? bmap.get(b) : 0);
      // Kumuliert nur fuer Zeit-Metriken sinnvoll (Bucket-Deltas aufsummiert →
      // total investierte Zeit). Inhaltsmetriken sind bereits kumulative
      // Snapshot-Groessen, daher dort kein Cumulative-Toggle im UI.
      if (cumulative) series = accumulate(series);
      datasets = [asBars
        ? { label: metricLabel, data: series, backgroundColor: primary, borderWidth: 0 }
        : {
          label: metricLabel,
          data: series,
          borderColor: primary,
          backgroundColor: primary + '12',
          pointBackgroundColor: primary,
          borderWidth: 2,
          tension: 0.35,
          pointRadius: 3,
          pointHoverRadius: 6,
          fill: true,
          spanGaps: false,
        }];
    }

    // Ziellinie: nur Schreibzeit pro Tag mit gesetztem Tagesziel — fuer Woche/
    // Monat oder kumuliert gaebe es keinen sinnvoll vergleichbaren Zielwert.
    const goal = this.myStatsGoal();
    if (metric === 'writing' && gran === 'day' && !cumulative && goal.active) {
      datasets.push({
        type: 'line',
        label: window.__app.t('mystats.chart.goalLine', { n: goal.goalMinutes }),
        data: buckets.map(() => goal.goalMinutes),
        borderColor: success,
        borderDash: [4, 4],
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 0,
        fill: false,
        order: -1,
      });
    }

    this._ensureThemeObserver();

    const stacked = asBars && byBook;
    _holder.set(new window.Chart(canvas, {
      type: asBars ? 'bar' : 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: byBook || datasets.length > 1,
            position: 'bottom',
            labels: { boxWidth: 12, boxHeight: 12, font: { size: 11 }, color: muted, usePointStyle: true },
          },
          tooltip: { callbacks: { label: ctx => ctx.parsed.y == null ? null : ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)}` } },
        },
        scales: {
          x: { stacked, grid: { color: gridLine }, ticks: { font: { size: 11 }, color: muted, maxTicksLimit: 12 } },
          y: {
            stacked,
            grid: { color: gridLine },
            beginAtZero: true,
            title: { display: !!unit, text: unit, color: muted, font: { size: 11 } },
            ticks: {
              font: { size: 11 }, color: muted,
              callback: v => fmt(v),
              stepSize: (metric === 'page_count' || metric === 'chapter_count') ? 1 : undefined,
            },
          },
        },
      },
    }));
  },
};
