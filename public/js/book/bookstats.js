// Buchschreibungsentwicklung – Zeitliniendiagramm.
// Methoden werden in Alpine.data('bookStatsCard') gespreadet; Root-Zugriffe via window.__app.

import { escHtml, fetchJson, localeTag, localIsoDaysAgo, tzOpts } from '../utils.js';
import { loadChart } from '../lazy-libs.js';
import { createChartHolder, cssVar } from '../cards/chart-holder.js';
import {
  computeAvgSummary, metricKind, rollingSeries, rollingWindowForRange, trendSeries,
} from './bookstats-avg.js';


// Chart-Labels kommen zur Render-Zeit über t() (siehe _metricLabel()), damit sie
// bei Sprachwechsel live nachgezogen werden.
const METRIC_KEYS = {
  chars:              'bookstats.metric.chars',
  normseiten:         'bookstats.metric.normseiten',
  words:              'bookstats.metric.words',
  page_count:         'bookstats.metric.pages',
  tok:                'bookstats.metric.tok',
  unique_words:       'bookstats.metric.unique',
  delta_chars:        'bookstats.metric.deltaChars',
  delta_words:        'bookstats.metric.delta',
  avg_sentence_len:   'bookstats.metric.avgSentence',
  pages_per_chapter:  'bookstats.metric.pagesPerChapter',
  avg_lix:            'bookstats.metric.lix',
  avg_flesch_de:      'bookstats.metric.flesch',
  mattr:              'bookstats.metric.mattr',
  mtld:               'bookstats.metric.mtld',
  lex_density:        'bookstats.metric.lexDensity',
  hapax_ratio:        'bookstats.metric.hapaxRatio',
  writing_minutes:    'bookstats.metric.writingMinutes',
  writing_cumulative: 'bookstats.metric.writingCumulative',
  lektorat_minutes:    'bookstats.metric.lektoratMinutes',
  lektorat_cumulative: 'bookstats.metric.lektoratCumulative',
  stt_minutes:         'bookstats.metric.sttMinutes',
  stt_cumulative:      'bookstats.metric.sttCumulative',
  stt_chars:           'bookstats.metric.sttChars',
};

// Wortschatz-Kennzahlen aus dem nächtlichen Scan (book_stats_history, Migration
// 308). Längenrobust — anders als `unique_words`, das vor allem die Buchlänge misst.
const LEXICON_METRICS  = new Set(['mattr', 'mtld', 'lex_density', 'hapax_ratio']);
const PERCENT_METRICS  = new Set(['lex_density', 'hapax_ratio']);
const WRITING_METRICS  = new Set(['writing_minutes',  'writing_cumulative']);
const LEKTORAT_METRICS = new Set(['lektorat_minutes', 'lektorat_cumulative']);
const STT_METRICS      = new Set(['stt_minutes', 'stt_cumulative', 'stt_chars']);
const MINUTES_METRICS    = new Set(['writing_minutes',    'lektorat_minutes',    'stt_minutes']);
const CUMULATIVE_METRICS = new Set(['writing_cumulative', 'lektorat_cumulative', 'stt_cumulative']);

// Ausserhalb von Alpine gespeichert, damit die Chart.js-Instanz nicht durch
// Alpines Reaktivitäts-Proxy beschädigt wird.
const _stats = createChartHolder();

function _ensureThemeObserver(component) {
  _stats.ensureThemeRedraw(() => {
    if (!window.__app?.showBookStatsCard) return;
    _stats.destroy();
    component.renderStatsChart();
  });
}

export function _disconnectThemeObserver() { _stats.disconnect(); }

export function _destroyStatsChart() { _stats.destroy(); }

// Badge-Texte der Ø-Zeile. Bestandsgrössen zeigen den Ø-ZUWACHS (mit Vorzeichen),
// Tagesmengen die Ø-Menge pro Kalendertag plus Σ und Ø je aktivem Tag,
// Verhältniszahlen den Ø-Wert.
function _avgBadges(s, metricLabel, fmtAvg) {
  const t = (key, params) => window.__app.t(key, params);
  const num = v => ((s.kind === 'stock' && v >= 0) ? '+' : '') + fmtAvg(v);
  const badges = [];
  if (s.kind === 'rate') {
    badges.push(t('bookstats.avgLevelBadge', { v: fmtAvg(s.perDay) }));
  } else {
    badges.push(t('bookstats.avgPerDay', { v: num(s.perDay) }));
    badges.push(t('bookstats.avgPerWeek', { v: num(s.perWeek) }));
    badges.push(t('bookstats.avgPerMonth', { v: num(s.perMonth) }));
  }
  if (s.kind === 'flow') {
    badges.push(t('bookstats.avgTotal', { v: fmtAvg(s.total) }));
    if (s.activeDays && s.activeDays < s.spanDays) {
      badges.push(t('bookstats.avgPerActiveDay', { v: fmtAvg(s.mean), n: s.activeDays }));
    }
  }
  return { label: t('bookstats.avgTitle', { days: s.spanDays }), metricLabel, badges };
}

export const bookstatsMethods = {
  async loadBookStats(bookId) {
    const results = await Promise.allSettled([
      fetchJson('/history/book-stats/' + bookId),
      fetchJson('/history/coverage/' + bookId),
      fetchJson('/history/writing-time/' + bookId),
      fetchJson('/history/lektorat-time/' + bookId),
      fetchJson('/history/stt-time/' + bookId),
    ]);

    // Stale-Guard: spätere Response eines alten Buchs nicht in neuen State kippen.
    if (String(bookId) !== String(Alpine.store('nav').selectedBookId)) return;

    const failed = results.filter(r => r.status === 'rejected');
    for (const r of failed) console.error('[loadBookStats]', r.reason);

    const [rowsRes, coverageRes, writingRes, lektoratRes, sttRes] = results;
    const rows = rowsRes.status === 'fulfilled' ? rowsRes.value : [];
    this.bookStatsData = rows;
    this.bookStatsCoverage = coverageRes.status === 'fulfilled' ? coverageRes.value : null;
    this.writingTimeData = writingRes.status === 'fulfilled' ? writingRes.value : null;
    this.lektoratTimeData = lektoratRes.status === 'fulfilled' ? lektoratRes.value : null;
    this.sttTimeData = sttRes.status === 'fulfilled' ? sttRes.value : null;
    const last = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    this.bookStatsDelta = (last && prev) ? last.words - prev.words : null;

    if (failed.length && !rows.length && !this.writingTimeData?.daily?.length) {
      this.bookStatsSyncStatus = window.__app.t('bookstats.loadError');
    }

    // rAF innerhalb von $nextTick: Alpine flusht das x-show (display:block) erst,
    // $nextTick garantiert aber nur das DOM-Update, keinen Layout-Pass. Ohne rAF
    // liest Chart.js gelegentlich ein noch 0×0 grosses Canvas und bleibt leer.
    this.$nextTick(() => requestAnimationFrame(() => this.renderStatsChart()));
  },

  async syncBookStats() {
    if (this.bookStatsLoading) return;
    this.bookStatsLoading = true;
    this.bookStatsSyncStatus = `<span class="spinner"></span>${window.__app.t('bookstats.syncing')}`;
    try {
      const result = await fetchJson('/sync/book/' + Alpine.store('nav').selectedBookId, { method: 'POST' });
      if (result.error) throw new Error(result.error);
      const tag = localeTag(Alpine.store('shell').uiLocale);
      const now = new Date().toLocaleTimeString(tag, tzOpts({ hour: '2-digit', minute: '2-digit' }));
      this.bookStatsSyncStatus = window.__app.t('bookstats.syncDone', { time: now });
      await this.loadBookStats(Alpine.store('nav').selectedBookId);
      // page_stats-Cache in tokEsts übernehmen, falls Seiten geladen.
      // In EINEM Rutsch reassignen statt per Index-Assign in der Schleife: der
      // `tokTotals`-Getter (app/app-root-getters.js) cached ueber die Identitaet
      // von `tokEsts`. Eine In-Place-Mutation laesst die Identitaet stehen → die
      // Sidebar-Σ-Zeile bliebe auf dem Stand vor dem Sync, waehrend die
      // Per-Seiten-Badges darunter schon die neuen Zahlen zeigen.
      if (Alpine.store('nav').pages.length) {
        const cache = await fetchJson('/history/page-stats/' + Alpine.store('nav').selectedBookId);
        const patch = {};
        for (const p of Alpine.store('nav').pages) {
          const c = cache[p.id];
          if (c && c.updated_at === p.updated_at) {
            patch[p.id] = { tok: c.tok, words: c.words, chars: c.chars };
          }
        }
        if (Object.keys(patch).length) {
          window.__app.tokEsts = { ...window.__app.tokEsts, ...patch };
        }
      }
    } catch (e) {
      this.bookStatsSyncStatus = window.__app.t('common.errorColon') + escHtml(e.message || '');
    } finally {
      this.bookStatsLoading = false;
    }
  },

  async renderStatsChart() {
    const canvas = document.getElementById('book-stats-chart');
    if (!canvas) return;

    // Chart.js on demand laden (~200 KB). Nur beim ersten Render der Karte.
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

    // Chart immer frisch aufbauen. Der Update-Pfad (chart.update) liest keine
    // neuen Canvas-Dimensionen ein — nach einem display:none↔block-Wechsel
    // (Buchwechsel: bookStatsData = [] → = rows) bleibt das Diagramm sonst
    // mit stale Dimensionen leer, bis ein Reflow nachzieht.
    _stats.destroy();

    const metric = this.bookStatsMetric;
    const isWriting  = WRITING_METRICS.has(metric);
    const isLektorat = LEKTORAT_METRICS.has(metric);
    const isStt      = STT_METRICS.has(metric);

    // Writing-/Lektorat-/STT-Metriken laufen auf der writing_time/lektorat_time/
    // stt_time-Zeitachse (nur aktive Tage), nicht auf der book_stats_history-
    // Timeline — sonst fehlen Tage ohne Sync, und Snapshots ohne Tracking-Zeit
    // würden als 0-Punkte erscheinen.
    let rows;
    if (isWriting)       rows = (this.writingTimeData?.daily  || []).map(d => ({ recorded_at: d.date, seconds: d.seconds }));
    else if (isLektorat) rows = (this.lektoratTimeData?.daily || []).map(d => ({ recorded_at: d.date, seconds: d.seconds }));
    else if (isStt)      rows = (this.sttTimeData?.daily      || []).map(d => ({ recorded_at: d.date, seconds: d.seconds, chars: d.chars }));
    else                 rows = this.bookStatsData;
    if (!rows.length) { this.bookStatsAvg = null; return; }

    // Zeitraum-Filter
    if (this.bookStatsRange > 0) {
      // App-TZ-Datum wie die recorded_at-Buckets des Servers (toISOString wäre UTC).
      const cutoffStr = localIsoDaysAgo(this.bookStatsRange);
      rows = rows.filter(r => r.recorded_at >= cutoffStr);
    }

    const isDelta = metric === 'delta_words' || metric === 'delta_chars';
    const isPpc   = metric === 'pages_per_chapter';
    const isMin   = MINUTES_METRICS.has(metric);
    const isCum   = CUMULATIVE_METRICS.has(metric);
    let data;
    if (metric === 'delta_words') data = rows.map((r, i) => i === 0 ? null : r.words - rows[i - 1].words);
    else if (metric === 'delta_chars') data = rows.map((r, i) => i === 0 ? null : (Number(r.chars) || 0) - (Number(rows[i - 1].chars) || 0));
    else if (metric === 'normseiten') data = rows.map(r => Math.round(((Number(r.chars) || 0) / 1500) * 10) / 10);
    else if (isPpc) data = rows.map(r => r.chapter_count > 0 ? Math.round((r.page_count / r.chapter_count) * 10) / 10 : null);
    else if (isMin) data = rows.map(r => Math.round(r.seconds / 60));
    else if (isCum) { let sum = 0; data = rows.map(r => { sum += r.seconds; return Math.round(sum / 360) / 10; }); }
    else if (metric === 'stt_chars') data = rows.map(r => Number(r.chars) || 0);
    // Anteile (0..1) als Prozent zeigen — dieselbe Darstellung wie in der Wortschatz-Karte.
    else if (PERCENT_METRICS.has(metric)) data = rows.map(r => r[metric] == null ? null : Math.round(r[metric] * 1000) / 10);
    else data = rows.map(r => r[metric] ?? null);

    // Leading-Null-Tage abschneiden: X-Achse startet am ersten echten Messpunkt
    // der gewählten Metrik (z.B. "wörter" erst ab Tag, an dem der Wert existiert).
    const firstIdx = data.findIndex(v => v !== null && v !== undefined);
    if (firstIdx > 0) { rows = rows.slice(firstIdx); data = data.slice(firstIdx); }
    else if (firstIdx === -1) { this.bookStatsAvg = null; return; }

    const labels = rows.map(r => {
      const [y, m, d] = r.recorded_at.split('-');
      return `${d}.${m}.${y.slice(2)}`;
    });

    const metricLabel = METRIC_KEYS[metric] ? window.__app.t(METRIC_KEYS[metric]) : metric;

    const tag = localeTag(Alpine.store('shell').uiLocale);
    const isDecimal = isPpc || isCum || metric === 'avg_sentence_len' || metric === 'avg_lix' || metric === 'avg_flesch_de' || metric === 'normseiten'
      || LEXICON_METRICS.has(metric);
    // MATTR bewegt sich in der dritten Nachkommastelle — mit einer Stelle wäre die
    // Kurve eine Treppe aus zwei Werten.
    const digits = metric === 'mattr' ? 3 : 1;
    const fmt = v => isDecimal ? v.toLocaleString(tag, { minimumFractionDigits: digits, maximumFractionDigits: digits })
      : Math.round(v).toLocaleString(tag);
    const makeTick = () => v => {
      if (v === null) return '';
      return (isDelta && v >= 0 ? '+' : '') + fmt(v);
    };
    const makeTooltip = () => ctx => {
      const v = ctx.parsed.y;
      if (v === null) return '';
      return ` ${ctx.dataset.label}: ${isDelta && v >= 0 ? '+' : ''}${fmt(v)}`;
    };

    // Durchschnitte sind Mittelwerte, keine Messpunkte: eine Nachkommastelle
    // auch dort, wo die Kurve selbst ganzzahlig tickt (0,4 Seiten/Tag ist eine
    // Aussage, gerundete "0" ist keine).
    const fmtAvg = (v) => {
      if (isDecimal) return fmt(v);
      const digits = Math.abs(v) < 10 ? 1 : 0;
      return v.toLocaleString(tag, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    };

    const primary  = cssVar('--color-primary');
    const muted    = cssVar('--color-muted');
    const accent   = cssVar('--color-accent');
    const gridLine = cssVar('--color-border');

    // Ø-Auswertung des sichtbaren Ausschnitts: Kennzahlen unter dem Diagramm
    // (Ø/Tag, Ø/Woche, Ø/Monat) und die Overlay-Serien im Diagramm.
    const kind = metricKind(metric);
    const dates = rows.map(r => r.recorded_at);
    const summary = computeAvgSummary({ kind, dates, values: data });
    this.bookStatsAvg = summary ? _avgBadges(summary, metricLabel, fmtAvg) : null;

    const overlay = (label, series, color, dash, tension) => ({
      label,
      data: series,
      borderColor: color,
      borderWidth: 1.5,
      borderDash: dash,
      tension,
      pointRadius: 0,
      pointHoverRadius: 0,
      fill: false,
      spanGaps: true,
    });

    const datasets = [{
      label: metricLabel,
      data,
      borderColor: primary,
      backgroundColor: primary + '12',
      borderWidth: 2,
      tension: 0.35,
      pointRadius: 4,
      pointHoverRadius: 6,
      pointBackgroundColor: primary,
      fill: true,
      spanGaps: false,
    }];

    let rollingWindow = 0;
    if (summary && this.bookStatsShowAvg) {
      if (kind === 'stock') {
        // Bestandsgrösse: die Gerade vom ersten zum letzten Messpunkt zeigt,
        // welche Phasen über und welche unter dem Ø-Zuwachs lagen. Ein
        // gleitendes Mittel waere hier nur eine verzoegerte Kopie der Kurve.
        const trend = trendSeries(dates, data);
        if (trend.some(v => v != null)) {
          datasets.push({ ...overlay(window.__app.t('bookstats.avgTrend'), trend, muted, [6, 4], 0), swNoTooltip: true });
        }
      } else {
        datasets.push({
          ...overlay(window.__app.t('bookstats.avgLine'), data.map(() => summary.perDay), muted, [6, 4], 0),
          swNoTooltip: true,
        });
        rollingWindow = rollingWindowForRange(this.bookStatsRange);
        const rolling = rollingSeries(dates, data, rollingWindow, { perDay: kind === 'flow' });
        if (rolling.some(v => v != null)) {
          datasets.push(overlay(
            window.__app.t('bookstats.avgRolling', { n: rollingWindow }), rolling, accent, [4, 3], 0.3,
          ));
        }
      }
    }

    _ensureThemeObserver(this);

    _stats.set(new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: datasets.length > 1,
            position: 'bottom',
            labels: { color: muted, boxWidth: 18, boxHeight: 1, font: { size: 11 }, padding: 12 },
          },
          tooltip: {
            // Die konstante Ø-Linie bzw. die Ø-Gerade steht in der Legende und
            // in den Badges — im Tooltip waere sie an jedem Punkt dieselbe Zahl.
            filter: item => !item.dataset.swNoTooltip,
            callbacks: {
              label: makeTooltip(),
            },
          },
        },
        scales: {
          x: {
            grid: { color: gridLine },
            ticks: { font: { size: 11 }, color: muted },
          },
          y: {
            grid: { color: gridLine },
            beginAtZero: false,
            ticks: {
              font: { size: 11 },
              color: muted,
              callback: makeTick(),
              stepSize: metric === 'page_count' ? 1 : undefined,
            },
          },
        },
      },
    }));
  },
};
