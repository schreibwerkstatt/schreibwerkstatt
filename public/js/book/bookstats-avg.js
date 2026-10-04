// Durchschnitts-Auswertung der Buchentwicklungs-Kurve.
//
// Reine Funktionen ohne DOM/Chart.js — die Kennzahlen unter dem Diagramm und
// die Overlay-Serien (Ø-Linie, gleitender Ø, Ø-Entwicklung) sind damit ohne
// Browser testbar (tests/unit/bookstats-avg.test.mjs).
//
// Drei Metrik-Arten, drei Aussagen:
//   stock — Bestandsgrösse (Zeichen, Wörter, kumulierte Stunden). Interessant
//           ist der Ø-ZUWACHS pro Tag/Woche/Monat, nicht das Ø-Niveau.
//   flow  — Tagesmenge (Δ Zeichen, Minuten, diktierte Zeichen). Interessant
//           ist die Ø-Menge pro Kalendertag, dazu Σ und Ø je aktivem Tag.
//   rate  — Verhältniszahl (Satzlänge, LIX, Flesch, S./Kap.). Interessant ist
//           der Ø-Wert im Zeitraum.

const DAY_MS = 86400000;

const STOCK_METRICS = new Set([
  'chars', 'normseiten', 'words', 'page_count', 'tok', 'unique_words',
  'writing_cumulative', 'lektorat_cumulative', 'stt_cumulative',
]);

const FLOW_METRICS = new Set([
  'delta_chars', 'delta_words',
  'writing_minutes', 'lektorat_minutes', 'stt_minutes', 'stt_chars',
]);

const RATE_METRICS = new Set([
  'avg_sentence_len', 'pages_per_chapter', 'avg_lix', 'avg_flesch_de',
  'mattr', 'mtld', 'lex_density', 'hapax_ratio',
]);

// Drift-Guard für den Test: jede Metrik des Charts muss hier eingeordnet sein.
export const CLASSIFIED_METRICS = new Set([...STOCK_METRICS, ...FLOW_METRICS, ...RATE_METRICS]);

export function metricKind(metric) {
  if (STOCK_METRICS.has(metric)) return 'stock';
  if (FLOW_METRICS.has(metric)) return 'flow';
  return 'rate';
}

// Tagesnummer aus 'YYYY-MM-DD'. Bewusst UTC: die Strings sind bereits lokale
// Kalendertage (Server schreibt sie über lib/local-date.js), eine zweite
// Zeitzonen-Umrechnung würde sie nur verschieben.
export function dayNumber(iso) {
  return Math.round(Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

// Fensterbreite des gleitenden Durchschnitts, passend zum gewählten Zeitraum:
// kurze Auswahl → kurzes Fenster, sonst bliebe die Linie leer.
export function rollingWindowForRange(range) {
  const r = Number(range) || 0;
  if (r === 7) return 3;
  if (r === 30 || r === 90) return 7;
  return 30; // 1 Jahr + "Alles"
}

function firstLastIdx(values) {
  let first = -1;
  let last = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null || !Number.isFinite(values[i])) continue;
    if (first === -1) first = i;
    last = i;
  }
  return [first, last];
}

/**
 * Kennzahlen des sichtbaren Ausschnitts.
 * @returns {null|{kind:string, spanDays:number, activeDays:number, perDay:number,
 *   perWeek:number, perMonth:number, level:number, total:number, delta:number,
 *   mean:number, from:string, to:string}}
 */
export function computeAvgSummary({ metric, kind, dates, values }) {
  const k = kind || metricKind(metric);
  const [firstIdx, lastIdx] = firstLastIdx(values);
  if (firstIdx === -1) return null;

  const dFirst = dayNumber(dates[firstIdx]);
  const dLast = dayNumber(dates[lastIdx]);
  const spanDays = Math.max(1, dLast - dFirst + 1);
  const elapsedDays = Math.max(1, dLast - dFirst);

  let total = 0;
  let activeDays = 0;
  for (let i = firstIdx; i <= lastIdx; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    total += v;
    activeDays++;
  }
  const mean = total / activeDays;

  let perDay;
  let delta = null;
  if (k === 'stock') {
    delta = values[lastIdx] - values[firstIdx];
    perDay = (dLast === dFirst) ? 0 : delta / elapsedDays;
  } else if (k === 'flow') {
    perDay = total / spanDays;
  } else {
    perDay = mean;
  }

  return {
    kind: k,
    spanDays,
    elapsedDays,
    activeDays,
    perDay,
    perWeek: perDay * 7,
    perMonth: perDay * 30,
    total,
    delta,
    mean,
    level: values[lastIdx],
    from: String(dates[firstIdx]).slice(0, 10),
    to: String(dates[lastIdx]).slice(0, 10),
  };
}

/**
 * Gleitender Durchschnitt über ein KALENDER-Fenster (nicht über N Punkte) —
 * Snapshots fehlen an Tagen ohne Sync, ein Index-Fenster hiesse sonst je nach
 * Lücke etwas anderes als das Label "Ø {n} Tage" verspricht.
 * `perDay` teilt durch die Kalendertage des Fensters (Flow-Metriken: Tage ohne
 * Eintrag sind echte Null-Tage), sonst durch die Zahl der Punkte.
 */
export function rollingSeries(dates, values, windowDays, { perDay = false } = {}) {
  const days = dates.map(dayNumber);
  const [firstIdx] = firstLastIdx(values);
  if (firstIdx === -1) return values.map(() => null);

  return values.map((_, i) => {
    if (i < firstIdx) return null;
    const end = days[i];
    const start = end - (windowDays - 1);
    let sum = 0;
    let count = 0;
    for (let j = firstIdx; j <= i; j++) {
      if (days[j] < start) continue;
      const v = values[j];
      if (v == null || !Number.isFinite(v)) continue;
      sum += v;
      count++;
    }
    if (!count) return null;
    if (!perDay) return sum / count;
    const covered = Math.min(windowDays, end - days[firstIdx] + 1);
    return sum / Math.max(1, covered);
  });
}

/**
 * Gerade vom ersten zum letzten Messpunkt: die Ø-Entwicklung, an der man
 * ablesen kann, ob eine Phase über oder unter dem Schnitt lag.
 */
export function trendSeries(dates, values) {
  const [firstIdx, lastIdx] = firstLastIdx(values);
  if (firstIdx === -1 || firstIdx === lastIdx) return values.map(() => null);
  const days = dates.map(dayNumber);
  const dFirst = days[firstIdx];
  const spread = days[lastIdx] - dFirst;
  if (spread <= 0) return values.map(() => null);
  const slope = (values[lastIdx] - values[firstIdx]) / spread;
  return values.map((_, i) => {
    if (i < firstIdx || i > lastIdx) return null;
    return values[firstIdx] + slope * (days[i] - dFirst);
  });
}
