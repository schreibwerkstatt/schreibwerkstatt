// Buchschreibungsentwicklung – Zeitliniendiagramm.
// Methoden werden in Alpine.data('bookStatsCard') gespreadet; Root-Zugriffe via window.__app.

import {
  charsToNormseiten, escHtml, fetchJson, formatIsoDay, formatNumber, localeTag, localIsoDaysAgo, resolveDailyGoal, tzOpts,
} from '../utils.js';
import { loadChart } from '../lazy-libs.js';
import { createChartHolder } from '../cards/chart-holder.js';
import {
  barDataset, calendarAxisLabel, calendarTooltipLabel, chartPalette, compactTick,
  crosshairPlugin, lineDataset, refLineDataset, timeSeriesOptions, withAlpha,
} from '../cards/chart-style.js';
import {
  bucketFor, bucketSeries, computeAvgSummary, fillCalendar, metricKind, rollingSeries,
  rollingWindowForRange, tempoRows, trendSeries,
} from './bookstats-avg.js';
import { statusDistribution } from '../redaktion/status.js';


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
  status_done:         'bookstats.metric.statusDone',
  status_set:          'bookstats.metric.statusSet',
  chars_per_hour:      'bookstats.metric.charsPerHour',
};

// Wortschatz-Kennzahlen aus dem nächtlichen Scan (book_stats_history, Migration
// 308). Längenrobust — anders als `unique_words`, das vor allem die Buchlänge misst.
const LEXICON_METRICS  = new Set(['mattr', 'mtld', 'lex_density', 'hapax_ratio']);
const PERCENT_METRICS  = new Set(['lex_density', 'hapax_ratio']);
const WRITING_METRICS  = new Set(['writing_minutes',  'writing_cumulative']);
const LEKTORAT_METRICS = new Set(['lektorat_minutes', 'lektorat_cumulative']);
const STT_METRICS      = new Set(['stt_minutes', 'stt_cumulative', 'stt_chars']);
// Schreibtempo: Snapshot-Zuwachs ÷ Schreibzeit desselben Tags (bookstats-avg.js#tempoRows).
const TEMPO_METRICS    = new Set(['chars_per_hour']);
// Bearbeitungsstand (docs/bearbeitungsstand.md): eigene Zeitachse aus
// page_editorial_status_events, nur Tage mit Stufenwechsel.
const STATUS_METRICS   = new Set(['status_done', 'status_set']);
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

// Verlauf des Bearbeitungsstands → Zeilen der Kurve: `done` = Abschnitte auf der
// letzten Stufe der Kette, `set` = Abschnitte mit irgendeiner Stufe.
export function statusRows(history) {
  const chain = history?.stufen || [];
  const last = chain[chain.length - 1];
  return (history?.daily || []).map(d => ({
    recorded_at: d.date,
    done: last ? (d[last] || 0) : 0,
    set: chain.reduce((a, s) => a + (d[s] || 0), 0),
  }));
}

// Badge-Texte der Ø-Zeile. Bestandsgrössen zeigen den Ø-ZUWACHS (mit Vorzeichen),
// Tagesmengen die Ø-Menge pro Kalendertag plus Σ und Ø je aktivem Tag,
// Verhältniszahlen den Ø-Wert.
function _avgBadges(s, metricLabel, fmtAvg, bucket) {
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
    if (s.activeDays > 0 && s.activeDays < s.spanDays) {
      badges.push(t('bookstats.avgPerActiveDay', { v: fmtAvg(s.mean), n: s.activeDays }));
    }
  }
  const label = t('bookstats.avgTitle', { days: s.spanDays })
    + (bucket === 'day' ? '' : ' · ' + t('bookstats.bucket.' + bucket));
  return { label, metricLabel, badges };
}

// Tagesreihe der gewählten Metrik aus den Rohzeilen. Δ-Werte entstehen hier,
// VOR dem Zeitraum-Filter — sonst fehlte der erste sichtbare Tag.
function _metricSeries(metric, rows) {
  const num = v => Number(v) || 0;
  switch (metric) {
    case 'delta_words': return rows.map((r, i) => (i === 0 ? null : num(r.words) - num(rows[i - 1].words)));
    case 'delta_chars': return rows.map((r, i) => (i === 0 ? null : num(r.chars) - num(rows[i - 1].chars)));
    case 'normseiten': return rows.map(r => charsToNormseiten(r.chars));
    case 'pages_per_chapter': return rows.map(r => (r.chapter_count > 0 ? Math.round((r.page_count / r.chapter_count) * 10) / 10 : null));
    case 'writing_minutes': case 'lektorat_minutes': case 'stt_minutes': return rows.map(r => Math.round(r.seconds / 60));
    case 'writing_cumulative': case 'lektorat_cumulative': case 'stt_cumulative': {
      let sum = 0;
      return rows.map(r => { sum += r.seconds; return Math.round(sum / 360) / 10; });
    }
    case 'stt_chars': return rows.map(r => num(r.chars));
    case 'status_done': return rows.map(r => r.done);
    case 'status_set': return rows.map(r => r.set);
    case 'chars_per_hour': return rows.map(r => r.cph);
    default:
      // Anteile (0..1) als Prozent — dieselbe Darstellung wie in der Wortschatz-Karte.
      if (PERCENT_METRICS.has(metric)) return rows.map(r => (r[metric] == null ? null : Math.round(r[metric] * 1000) / 10));
      return rows.map(r => r[metric] ?? null);
  }
}

// Achsen- und Tooltip-Beschriftung eines Eimers.
function _bucketLabels(b, bucket, uiLocale, spansYears) {
  if (bucket === 'month') {
    return {
      axis: formatIsoDay(b.start, uiLocale, { month: 'short', year: '2-digit' }),
      tip: formatIsoDay(b.start, uiLocale, { month: 'long', year: 'numeric' }),
    };
  }
  if (bucket === 'week') {
    return {
      axis: calendarAxisLabel(b.start, uiLocale, spansYears),
      tip: window.__app.t('bookstats.bucketWeekTip', {
        from: formatIsoDay(b.start, uiLocale, { day: 'numeric', month: 'short' }),
        to: formatIsoDay(b.end, uiLocale),
      }),
    };
  }
  return { axis: calendarAxisLabel(b.start, uiLocale, spansYears), tip: calendarTooltipLabel(b.start, uiLocale) };
}


export const bookstatsMethods = {
  // Plakette „n/total Abschnitte final" aus dem aktuellen Stand (Seitenbaum-
  // Store), nicht aus dem Verlauf — der kennt nur Tage mit Wechsel.
  bookStatsStatusBadge() {
    const badges = Alpine.store('badges');
    const chain = badges.editStatusChain || [];
    const total = (Alpine.store('nav').pages || []).length;
    if (!chain.length || !total) return '';
    const counts = statusDistribution((Alpine.store('nav').pages || []).map(p => p.id), badges.editStatus, chain);
    if (counts.ohne === total) return '';
    const done = chain[chain.length - 1];
    return window.__app.t('bookstats.statusBadge', {
      n: counts[done], total, status: window.__app.t('redaktion.status.' + done),
    });
  },

  bookStatsLastSnapshotLabel() {
    const last = this.bookStatsData[this.bookStatsData.length - 1];
    if (!last?.recorded_at) return '';
    return window.__app.t('bookstats.lastSnapshot', { date: formatIsoDay(last.recorded_at, Alpine.store('shell').uiLocale) });
  },

  // Kennzahlen unter dem Diagramm in drei Gruppen: Umfang (letzter Snapshot),
  // Qualität (Lektorat, Stand, Satzbau) und Aufwand (Zeit-Tracker).
  bookStatsBadgeGroups() {
    const t = (k, p) => window.__app.t(k, p);
    const loc = Alpine.store('shell').uiLocale;
    const n0 = v => formatNumber(Number(v) || 0, loc, 0);
    const n1 = v => formatNumber(Number(v) || 0, loc, 1);
    const groups = [];
    const push = (key, badges) => {
      const list = badges.filter(Boolean);
      if (list.length) groups.push({ key, title: t('bookstats.group.' + key), badges: list });
    };

    const last = this.bookStatsData[this.bookStatsData.length - 1];
    if (last) {
      push('volume', [
        { text: n0(last.chars) + ' ' + t('bookstats.unit.z'), tip: t('bookstats.metric.chars') },
        { text: n1(charsToNormseiten(last.chars)) + ' ' + t('bookstats.unit.ns'), tip: t('bookstats.metric.normseiten') },
        { text: n0(last.words) + ' ' + t('bookstats.unit.w'), tip: t('bookstats.metric.words') },
        { text: n0(last.page_count) + ' ' + t('bookstats.unit.s'), tip: t('bookstats.metric.pages') },
        { text: n0(last.tok) + ' ' + t('bookstats.unit.t'), tip: t('bookstats.metric.tok') },
        this.bookStatsDelta !== null && {
          text: (this.bookStatsDelta >= 0 ? '+' : '') + n0(this.bookStatsDelta) + ' ' + t('bookstats.unit.delta'),
          tip: t('bookstats.metric.delta'),
        },
      ]);
    }

    const cov = this.bookStatsCoverage;
    const status = this.bookStatsStatusBadge();
    push('quality', [
      cov && { text: t('bookstats.coverage', { pct: cov.pct ?? 0, checked: cov.checked_pages ?? 0, total: cov.total_pages ?? 0 }) },
      status && { text: status },
      last?.avg_sentence_len != null && { text: t('bookstats.avgSentenceBadge', { n: n1(last.avg_sentence_len) }) },
      last?.chapter_count > 0 && { text: t('bookstats.pagesPerChapterBadge', { n: n1(last.page_count / last.chapter_count) }) },
    ]);

    const time = (d, totalKey, avgKey) => [
      (d?.total_seconds ?? 0) > 0 && { text: t(totalKey, { h: n1(d.total_seconds / 3600) }) },
      avgKey && (d?.active_days ?? 0) > 0 && { text: t(avgKey, { m: n0(d.total_seconds / 60 / d.active_days) }) },
    ];
    const tempo = this._bookStatsTempoSummary();
    push('effort', [
      ...time(this.writingTimeData, 'bookstats.writingTotal', 'bookstats.writingAvg'),
      tempo && { text: t('bookstats.tempoBadge', { n: n0(tempo) }), tip: t('bookstats.metric.charsPerHour') },
      ...time(this.lektoratTimeData, 'bookstats.lektoratTotal', 'bookstats.lektoratAvg'),
      ...time(this.sttTimeData, 'bookstats.sttTotal', null),
      (this.sttTimeData?.total_chars ?? 0) > 0 && { text: t('bookstats.sttChars', { n: n0(this.sttTimeData.total_chars) }) },
    ]);
    return groups;
  },

  // Ø Zeichen pro Schreibstunde über den ganzen Verlauf (Σ Zeichen / Σ Stunden).
  _bookStatsTempoSummary() {
    const rows = tempoRows(this.bookStatsData, this.writingTimeData?.daily);
    let chars = 0, hours = 0;
    for (const r of rows) if (r.cph != null) { chars += r.cph * r.hours; hours += r.hours; }
    return hours > 0 ? chars / hours : null;
  },

  async loadBookStats(bookId) {
    const results = await Promise.allSettled([
      fetchJson('/history/book-stats/' + bookId),
      fetchJson('/history/coverage/' + bookId),
      fetchJson('/history/writing-time/' + bookId),
      fetchJson('/history/lektorat-time/' + bookId),
      fetchJson('/history/stt-time/' + bookId),
      fetchJson('/redaktion/' + bookId + '/history'),
    ]);

    // Stale-Guard: spätere Response eines alten Buchs nicht in neuen State kippen.
    if (String(bookId) !== String(Alpine.store('nav').selectedBookId)) return;

    const failed = results.filter(r => r.status === 'rejected');
    for (const r of failed) console.error('[loadBookStats]', r.reason);

    const [rowsRes, coverageRes, writingRes, lektoratRes, sttRes, statusRes] = results;
    const rows = rowsRes.status === 'fulfilled' ? rowsRes.value : [];
    this.bookStatsData = rows;
    this.bookStatsCoverage = coverageRes.status === 'fulfilled' ? coverageRes.value : null;
    this.writingTimeData = writingRes.status === 'fulfilled' ? writingRes.value : null;
    this.lektoratTimeData = lektoratRes.status === 'fulfilled' ? lektoratRes.value : null;
    this.sttTimeData = sttRes.status === 'fulfilled' ? sttRes.value : null;
    this.statusHistoryData = statusRes.status === 'fulfilled' ? statusRes.value : null;
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
      // Nicht alle Abschnitte geladen: der Server behält den alten Tagesstand
      // (routes/sync.js#syncBook) — das gehört gesagt, nicht als „fertig" gemeldet.
      this.bookStatsSyncStatus = result.snapshot === false
        ? window.__app.tn('bookstats.syncPartial', result.missing_pages || 0, { time: now })
        : window.__app.t('bookstats.syncDone', { time: now });
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

  // Rohzeilen der gewählten Metrik: jede Quelle hat ihre eigene Zeitachse.
  _bookStatsRows(metric) {
    if (WRITING_METRICS.has(metric))  return (this.writingTimeData?.daily  || []).map(d => ({ recorded_at: d.date, seconds: d.seconds }));
    if (LEKTORAT_METRICS.has(metric)) return (this.lektoratTimeData?.daily || []).map(d => ({ recorded_at: d.date, seconds: d.seconds }));
    if (STT_METRICS.has(metric))      return (this.sttTimeData?.daily      || []).map(d => ({ recorded_at: d.date, seconds: d.seconds, chars: d.chars }));
    if (STATUS_METRICS.has(metric))   return statusRows(this.statusHistoryData);
    if (TEMPO_METRICS.has(metric))    return tempoRows(this.bookStatsData, this.writingTimeData?.daily);
    return this.bookStatsData;
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
    const kind = metricKind(metric);
    const isStatus = STATUS_METRICS.has(metric);
    let rows = this._bookStatsRows(metric);
    let data = _metricSeries(metric, rows);
    let weights = TEMPO_METRICS.has(metric) ? rows.map(r => r.hours) : null;

    // Zeitraum-Filter (App-TZ-Datum wie die recorded_at-Buckets des Servers).
    if (this.bookStatsRange > 0) {
      const cutoffStr = localIsoDaysAgo(this.bookStatsRange);
      const keep = rows.map(r => r.recorded_at >= cutoffStr);
      rows = rows.filter((_, i) => keep[i]);
      data = data.filter((_, i) => keep[i]);
      if (weights) weights = weights.filter((_, i) => keep[i]);
    }

    // X-Achse startet am ersten echten Messpunkt der gewählten Metrik.
    const firstIdx = data.findIndex(v => v != null);
    if (firstIdx === -1) { this.bookStatsAvg = null; return; }
    rows = rows.slice(firstIdx); data = data.slice(firstIdx);
    if (weights) weights = weights.slice(firstIdx);

    // Kalender: jeder Tag ein Platz auf der Achse (Tagesmengen mit 0 gefüllt).
    const cal = fillCalendar(rows.map(r => r.recorded_at), data, kind, weights);
    const summary = computeAvgSummary({ kind, dates: cal.dates, values: cal.values, weights: cal.weights });
    const bucket = bucketFor(this.bookStatsRange, cal.dates.length);
    const buckets = bucketSeries(cal.dates, cal.values, kind, bucket, cal.weights);
    const series = buckets.map(b => b.value);

    const uiLocale = Alpine.store('shell').uiLocale;
    const spansYears = cal.dates[0].slice(0, 4) !== cal.dates[cal.dates.length - 1].slice(0, 4);
    const labelsOf = buckets.map(b => _bucketLabels(b, bucket, uiLocale, spansYears));
    const metricLabel = METRIC_KEYS[metric] ? window.__app.t(METRIC_KEYS[metric]) : metric;

    const tag = localeTag(uiLocale);
    const isDelta = metric === 'delta_words' || metric === 'delta_chars';
    const isDecimal = metric === 'pages_per_chapter' || CUMULATIVE_METRICS.has(metric) || metric === 'avg_sentence_len'
      || metric === 'avg_lix' || metric === 'avg_flesch_de' || metric === 'normseiten' || LEXICON_METRICS.has(metric);
    // MATTR bewegt sich in der dritten Nachkommastelle — mit einer Stelle wäre die
    // Kurve eine Treppe aus zwei Werten.
    const digits = metric === 'mattr' ? 3 : 1;
    const fmt = v => formatNumber(isDecimal ? v : Math.round(v), uiLocale, isDecimal ? digits : 0);
    const signed = v => (isDelta && v > 0 ? '+' : '') + fmt(v);
    const compact = compactTick(tag, signed);
    const tick = v => (v === null ? '' : (isDelta && v > 0 ? '+' : '') + compact(v).replace(/^\+/, ''));

    // Durchschnitte sind Mittelwerte, keine Messpunkte: eine Nachkommastelle
    // auch dort, wo die Kurve selbst ganzzahlig tickt (0,4 Seiten/Tag ist eine
    // Aussage, gerundete "0" ist keine).
    const fmtAvg = (v) => (isDecimal ? fmt(v) : formatNumber(v, uiLocale, Math.abs(v) < 10 ? 1 : 0));

    const pal = chartPalette();
    const { primary, muted, accent } = pal;

    this.bookStatsAvg = summary ? _avgBadges(summary, metricLabel, fmtAvg, bucket) : null;

    const overlay = (label, values, color, dash, tension) => refLineDataset(color, {
      label, data: values, dash, tension, order: 0,
    });

    // Tagesmengen (Δ, Minuten, diktierte Zeichen) als Balken: ein Tageswert ist
    // eine Menge, kein Verlauf — als Linie wird er zum Zickzack zwischen Tagen.
    // Bestände und Verhältniszahlen als Fläche; Lücken (nicht gemessene Tage)
    // werden überbrückt. Negative Tage gedämpft.
    const asBars = kind === 'flow';
    const main = asBars
      ? barDataset(pal, series.map(v => (v != null && v < 0 ? muted : primary)), { label: metricLabel, data: series, order: 1 })
      : lineDataset(pal, primary, { label: metricLabel, data: series, area: true, sparse: series.filter(v => v != null).length <= 14, spanGaps: true, order: 1 });
    const datasets = [main];

    if (summary && this.bookStatsShowAvg) {
      if (kind === 'stock') {
        // Bestandsgrösse: die Gerade vom ersten zum letzten Messpunkt zeigt,
        // welche Phasen über und welche unter dem Ø-Zuwachs lagen. Ein
        // gleitendes Mittel waere hier nur eine verzoegerte Kopie der Kurve.
        const trend = trendSeries(buckets.map(b => b.end), series);
        if (trend.some(v => v != null)) {
          datasets.push({ ...overlay(window.__app.t('bookstats.avgTrend'), trend, muted, [6, 4], 0), swNoTooltip: true });
        }
      } else {
        // Ø je Eimer: eine Tagesmenge skaliert mit den Tagen des Eimers (Rand-
        // Eimer sind kürzer), eine Verhältniszahl bleibt ihr Ø-Niveau.
        const avgLine = buckets.map(b => (kind === 'flow' ? summary.perDay * b.days : summary.perDay));
        datasets.push({ ...overlay(window.__app.t('bookstats.avgLine'), avgLine, muted, [6, 4], 0), swNoTooltip: true });
        // Gleitender Ø nur in der Tagesansicht — über Wochen-/Monatseimer wäre
        // er eine zweite Glättung derselben Verdichtung.
        if (bucket === 'day') {
          const rollingWindow = rollingWindowForRange(this.bookStatsRange);
          const rolling = rollingSeries(cal.dates, cal.values, rollingWindow, { perDay: kind === 'flow' });
          if (rolling.some(v => v != null)) {
            datasets.push(overlay(window.__app.t('bookstats.avgRolling', { n: rollingWindow }), rolling, accent, [4, 3], 0.3));
          }
        }
      }
    }

    // Tagesziel (book_settings.daily_goal_chars, 0 = bewusst keins) als
    // Referenz bei Δ Zeichen — je Eimer mit seinen Tagen multipliziert.
    if (metric === 'delta_chars') {
      const goal = resolveDailyGoal(Alpine.store('progress').dailyProgressDailyGoalChars);
      if (goal > 0) {
        datasets.push(overlay(
          window.__app.t(bucket === 'day' ? 'bookstats.goalLine' : 'bookstats.goalLineBucket'),
          buckets.map(b => goal * b.days), accent, [2, 3], 0,
        ));
      }
    }

    _ensureThemeObserver(this);

    const options = timeSeriesOptions(pal, { legend: datasets.length > 1 });
    options.plugins.tooltip.filter = item => !item.dataset.swNoTooltip;
    options.plugins.tooltip.callbacks = {
      title: items => (items.length ? labelsOf[items[0].dataIndex].tip : ''),
      label: ctx => (ctx.parsed.y == null ? '' : ` ${ctx.dataset.label}: ${signed(ctx.parsed.y)}`),
    };
    Object.assign(options.scales.y, {
      // Bestände starten nicht bei null — sonst klebt die Kurve als flacher
      // Strich am oberen Rand. Tagesmengen dagegen brauchen die Null-Linie.
      beginAtZero: asBars,
    });
    Object.assign(options.scales.y.ticks, {
      callback: tick,
      stepSize: (metric === 'page_count' || isStatus) ? 1 : undefined,
    });
    if (asBars) {
      options.scales.y.grid.color = (c) => (c.tick?.value === 0 ? withAlpha(muted, 0.6) : pal.border);
    }

    // Der Mixed-Chart braucht den Typ am Chart und je Dataset (Ø-Overlays sind Linien).
    _stats.set(new Chart(canvas, {
      type: asBars ? 'bar' : 'line',
      data: { labels: labelsOf.map(l => l.axis), datasets },
      options,
      plugins: [crosshairPlugin(withAlpha(muted, 0.5))],
    }));
  },
};
