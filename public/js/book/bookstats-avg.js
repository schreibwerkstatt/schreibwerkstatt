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
//   rate  — Verhältniszahl (Satzlänge, LIX, Flesch, S./Kap., Zeichen/Stunde).
//           Interessant ist der Ø-Wert im Zeitraum; mit Gewichten (`weights`)
//           der gewogene Ø — Zeichen pro Schreibstunde ist Σ Zeichen / Σ Stunden,
//           nicht das Mittel der Tagesraten.
//
// Die X-Achse ist ein Kalender: `fillCalendar` legt jeden Tag zwischen erstem
// und letztem Messpunkt an (Tagesmengen mit 0, sonst leer), `bucketSeries`
// verdichtet lange Zeiträume zu Wochen bzw. Monaten.

const DAY_MS = 86400000;

const STOCK_METRICS = new Set([
  'chars', 'normseiten', 'words', 'page_count', 'tok', 'unique_words',
  'writing_cumulative', 'lektorat_cumulative', 'stt_cumulative',
  'status_done', 'status_set',
]);

const FLOW_METRICS = new Set([
  'delta_chars', 'delta_words',
  'writing_minutes', 'lektorat_minutes', 'stt_minutes', 'stt_chars',
]);

const RATE_METRICS = new Set([
  'avg_sentence_len', 'pages_per_chapter', 'avg_lix', 'avg_flesch_de',
  'mattr', 'mtld', 'lex_density', 'hapax_ratio', 'chars_per_hour',
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

export function isoFromDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
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
export function computeAvgSummary({ metric, kind, dates, values, weights = null }) {
  const k = kind || metricKind(metric);
  const [firstIdx, lastIdx] = firstLastIdx(values);
  if (firstIdx === -1) return null;

  const dFirst = dayNumber(dates[firstIdx]);
  const dLast = dayNumber(dates[lastIdx]);
  const spanDays = Math.max(1, dLast - dFirst + 1);
  const elapsedDays = Math.max(1, dLast - dFirst);

  // Aktiver Tag einer Tagesmenge = Tag mit Menge ≠ 0; aufgefüllte Kalendertage
  // (fillCalendar) zählen nicht. Bei Bestand/Verhältnis jeder Messpunkt.
  let total = 0;
  let points = 0;
  let activeDays = 0;
  let wSum = 0;
  let wTotal = 0;
  for (let i = firstIdx; i <= lastIdx; i++) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    total += v;
    points++;
    if (k !== 'flow' || v !== 0) activeDays++;
    if (weights) {
      const w = Number(weights[i]) || 0;
      wSum += v * w;
      wTotal += w;
    }
  }
  const mean = k === 'flow' ? (activeDays ? total / activeDays : 0) : total / points;

  let perDay;
  let delta = null;
  if (k === 'stock') {
    delta = values[lastIdx] - values[firstIdx];
    perDay = (dLast === dFirst) ? 0 : delta / elapsedDays;
  } else if (k === 'flow') {
    perDay = total / spanDays;
  } else {
    perDay = (weights && wTotal > 0) ? wSum / wTotal : mean;
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

/**
 * Jeden Kalendertag zwischen erstem und letztem Datum anlegen. Tagesmengen
 * (`flow`) bekommen an fehlenden Tagen 0 — kein Eintrag heisst nichts getan;
 * Bestände und Verhältniszahlen bleiben leer (nicht gemessen). `weights` wird
 * mitgeführt (fehlende Tage: 0).
 */
export function fillCalendar(dates, values, kind, weights = null) {
  if (!dates.length) return { dates: [], values: [], weights: weights ? [] : null };
  const byDay = new Map();
  dates.forEach((d, i) => byDay.set(dayNumber(d), i));
  const first = dayNumber(dates[0]);
  const last = dayNumber(dates[dates.length - 1]);
  const out = { dates: [], values: [], weights: weights ? [] : null };
  for (let n = first; n <= last; n++) {
    const i = byDay.get(n);
    out.dates.push(isoFromDay(n));
    out.values.push(i != null ? values[i] : (kind === 'flow' ? 0 : null));
    if (weights) out.weights.push(i != null ? (Number(weights[i]) || 0) : 0);
  }
  return out;
}

// Verdichtung: kurze Zeiträume tageweise, „1 J" wochenweise, „Alles" je nach
// Spanne (bis ~4 Monate Tage, bis ~13 Monate Wochen, darüber Monate) — ein
// junges Buch zeigt unter „Alles" sonst zwei Monatsbalken.
export function bucketFor(range, spanDays) {
  const r = Number(range) || 0;
  if (r > 0 && r <= 90) return 'day';
  if (spanDays <= 120) return 'day';
  if (r === 365 || spanDays <= 400) return 'week';
  return 'month';
}

// Erster Tag des Eimers (Woche ab Montag, Monat ab dem 1.).
export function bucketStart(iso, bucket) {
  if (bucket === 'month') return `${String(iso).slice(0, 7)}-01`;
  if (bucket === 'week') {
    const n = dayNumber(iso);
    const weekday = (new Date(n * DAY_MS).getUTCDay() + 6) % 7; // Mo = 0
    return isoFromDay(n - weekday);
  }
  return String(iso).slice(0, 10);
}

/**
 * Tagesreihe (lückenlos, aus fillCalendar) zu Eimern verdichten.
 * flow → Summe, stock → letzter Wert, rate → Mittel (mit `weights` gewogen).
 * `days` = Kalendertage des Eimers innerhalb der Reihe (Rand-Eimer sind kürzer),
 * damit Ø- und Ziel-Linien pro Eimer stimmen. `end` = letzter Tag im Eimer.
 */
export function bucketSeries(dates, values, kind, bucket, weights = null) {
  const out = [];
  let cur = null;
  dates.forEach((d, i) => {
    const key = bucketStart(d, bucket);
    if (!cur || cur.start !== key) {
      cur = { start: key, end: d, days: 0, sum: 0, n: 0, last: null, wSum: 0, wTotal: 0 };
      out.push(cur);
    }
    cur.end = d;
    cur.days++;
    const v = values[i];
    if (v == null || !Number.isFinite(v)) return;
    cur.sum += v;
    cur.n++;
    cur.last = v;
    if (weights) {
      const w = Number(weights[i]) || 0;
      cur.wSum += v * w;
      cur.wTotal += w;
    }
  });
  return out.map(b => {
    let value = null;
    if (b.n) {
      if (kind === 'flow') value = b.sum;
      else if (kind === 'stock') value = b.last;
      else value = (weights && b.wTotal > 0) ? b.wSum / b.wTotal : (weights ? null : b.sum / b.n);
    }
    return { start: b.start, end: b.end, days: b.days, value };
  });
}

// Schreibtempo zählt nur Tage mit mindestens so viel Schreibzeit: zwei Minuten
// und 3000 eingefügte Zeichen wären sonst 90 000 Zeichen pro Stunde.
export const TEMPO_MIN_SECONDS = 600;

/**
 * Zeichen pro Schreibstunde je Tag: Zuwachs des Tages-Snapshots gegenüber dem
 * vorigen, abzüglich Import-Zuwachs (`imported_chars` ist kumulativ, siehe
 * lib/import-baseline.js), geteilt durch die Schreibzeit desselben Tags.
 * `hours` ist das Gewicht für den Ø (Σ Zeichen / Σ Stunden).
 */
export function tempoRows(statsRows, writingDaily, minSeconds = TEMPO_MIN_SECONDS) {
  const secByDay = new Map((writingDaily || []).map(d => [d.date, Number(d.seconds) || 0]));
  const out = [];
  for (let i = 1; i < (statsRows || []).length; i++) {
    const r = statsRows[i];
    const p = statsRows[i - 1];
    const sec = secByDay.get(r.recorded_at) || 0;
    if (sec < minSeconds) { out.push({ recorded_at: r.recorded_at, cph: null, hours: 0 }); continue; }
    const imported = (Number(r.imported_chars) || 0) - (Number(p.imported_chars) || 0);
    const chars = (Number(r.chars) || 0) - (Number(p.chars) || 0) - imported;
    const hours = sec / 3600;
    out.push({ recorded_at: r.recorded_at, cph: chars / hours, hours });
  }
  return out;
}
