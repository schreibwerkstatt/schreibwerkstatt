// Pure Compute-Funktionen fuer die neueren „Meine Statistik"-Kacheln
// (Vorperioden-Vergleich, Session-Kennzahlen, Gesamt-Prognose, Wortschatz-Trend).
// Bewusst frei von Alpine/DOM → unit-testbar (tests/unit/my-stats-compute.test.mjs).
// Eigenes Modul neben der Compute-Facade (my-stats-compute.js + Subfolder).

import { localIsoDate, localIsoDaysAgo } from '../utils.js';
import { computeVolumeDelta, isoAddDays, isoDayDiff, commonBookIds, TREND_REF_DAYS,
         latestSnapshotPerBook, snapshotPerBookOnOrBefore } from './my-stats-compute.js';

// Schreib-Sekunden einer writing/lektorat-Reihe im Fenster [from, to] (inklusive).
function sumSecondsInWindow(rows, fromIso, toIso) {
  let s = 0;
  for (const r of (rows || [])) {
    const d = r.date;
    if (!d) continue;
    if (fromIso && d < fromIso) continue;
    if (toIso && d > toIso) continue;
    s += Number(r.seconds) || 0;
  }
  return s;
}

// Delta-Objekt zwischen aktuellem und Vorperioden-Wert. pct = null, wenn keine
// Vergleichsbasis existiert (prev <= 0) — dann ist eine Prozentangabe sinnlos.
function mkDelta(cur, prev) {
  const c = Number(cur) || 0, p = Number(prev) || 0;
  const delta = c - p;
  return {
    cur: c,
    prev: p,
    delta,
    pct: p > 0 ? Math.round((delta / p) * 100) : null,
    dir: delta > 0 ? 1 : delta < 0 ? -1 : 0,
  };
}

// Vergleich des aktiven Zeitraums mit der unmittelbar davorliegenden, gleich
// langen Periode. `historyRows` (book_stats_history) liefert den Zeichen-Zuwachs
// (Delta der kumulierten Snapshots), `writingRows` die Schreibsekunden. from/to
// sind ISO-Tagesdaten (inklusive); beide muessen gesetzt sein. `opts` geht an
// computeVolumeDelta (Live-Stand + Anlagedaten) — dieselbe Basis-Regel wie die
// Zeitraum-Kachel, sonst widersprechen sich Zahl und Vergleich.
export function computePeriodComparison(historyRows, writingRows, fromIso, toIso, opts = {}) {
  if (!fromIso || !toIso) return { available: false };
  const len = isoDayDiff(fromIso, toIso) + 1; // inklusive Tage
  if (len < 1) return { available: false };
  const prevTo = isoAddDays(fromIso, -1);
  const prevFrom = isoAddDays(prevTo, -(len - 1));

  const curVol = computeVolumeDelta(historyRows, fromIso, toIso, opts);
  const prevVol = computeVolumeDelta(historyRows, prevFrom, prevTo, opts);
  const curSec = sumSecondsInWindow(writingRows, fromIso, toIso);
  const prevSec = sumSecondsInWindow(writingRows, prevFrom, prevTo);

  return {
    available: true,
    days: len,
    prevFrom,
    prevTo,
    chars: mkDelta(curVol.chars, prevVol.chars),
    approximated: curVol.approximated || prevVol.approximated,
    writingSeconds: mkDelta(curSec, prevSec),
  };
}

// Session-Kennzahlen aus der writing_session-Reihe (Rows { book_id, date, seconds }).
// count = Anzahl Sessions, avgSeconds = Durchschnittslaenge, longestSeconds/-Date =
// laengste Session, activeDays = Tage mit >= 1 Session, perActiveDay = Sessions je
// aktivem Tag (eine Nachkommastelle).
export function computeSessionStats(sessionRows) {
  const rows = (sessionRows || []).filter(r => (Number(r.seconds) || 0) > 0);
  if (!rows.length) return { hasData: false };
  let total = 0, longest = 0, longestDate = null;
  const days = new Set();
  for (const r of rows) {
    const s = Number(r.seconds) || 0;
    total += s;
    if (s > longest) { longest = s; longestDate = r.date || null; }
    if (r.date) days.add(r.date);
  }
  const count = rows.length;
  return {
    hasData: true,
    count,
    totalSeconds: total,
    avgSeconds: Math.round(total / count),
    longestSeconds: longest,
    longestDate,
    activeDays: days.size,
    perActiveDay: days.size > 0 ? Math.round((count / days.size) * 10) / 10 : 0,
  };
}

// Gesamt-Prognose ueber alle Buecher mit gesetztem, noch offenem Gesamtziel.
// `bookGoals` ist die computeBookGoals-Ausgabe (enthaelt remainingChars +
// recentDailyChars je Buch). Summiert den offenen Rest-Umfang und das aktuelle
// Tages-Tempo → ein prognostiziertes Fertigstellungsdatum ueber alle Ziele.
const OVERALL_FORECAST_MAX_DAYS = 5000;

export function computeOverallForecast(bookGoals, todayLocal = new Date()) {
  const active = (bookGoals || []).filter(r => r.hasGoal && !r.reached && (r.remainingChars || 0) > 0);
  if (!active.length) return { hasData: false };
  let remaining = 0, daily = 0;
  for (const r of active) {
    remaining += Number(r.remainingChars) || 0;
    daily += Number(r.recentDailyChars) || 0;
  }
  if (daily <= 0) {
    return { hasData: true, booksOpen: active.length, remainingChars: remaining, dailyChars: 0, forecastDate: null, stalled: true };
  }
  const days = Math.ceil(remaining / daily);
  const forecastDate = days <= OVERALL_FORECAST_MAX_DAYS ? isoAddDays(localIsoDate(todayLocal), days) : null;
  return {
    hasData: true,
    booksOpen: active.length,
    remainingChars: remaining,
    dailyChars: daily,
    forecastDays: forecastDate ? days : null,
    forecastDate,
    stalled: !forecastDate,
  };
}

// Wortformen-Trend: Summe der unique_words ueber das letzte Snapshot je Buch,
// verglichen mit dem Stand vor TREND_REF_DAYS Tagen (`refIso`) — der Trend nur
// ueber die Buecher, die zu beiden Zeitpunkten existierten (ein neues Buch
// liesse die Summe sonst springen). total = aktuelle Summe der Wortformen, je
// Buch gezaehlt und addiert (dasselbe Wort in zwei Buechern zaehlt zweimal).
// Misst ueberwiegend Buchlaenge, darum im UI nicht „Wortschatz"
// (docs/wortschatz.md); die laengenrobusten Masse stehen im Autorenprofil und
// in der Buchstatistik.
export function computeVocabTrend(historyRows, todayLocal = new Date()) {
  const latest = latestSnapshotPerBook(historyRows);
  const refIso = localIsoDaysAgo(TREND_REF_DAYS, new Date(todayLocal));
  const past = snapshotPerBookOnOrBefore(historyRows, refIso);
  const common = commonBookIds(latest, past);
  const sumVocab = (map, onlyIds = null) => {
    let s = 0;
    for (const [id, r] of map) if (!onlyIds || onlyIds.has(id)) s += Number(r.unique_words) || 0;
    return s;
  };
  const total = sumVocab(latest);
  if (total <= 0) return { hasData: false };
  const now = sumVocab(latest, common);
  const before = sumVocab(past, common);
  let trend = 0;
  if (before > 0) {
    const d = now - before;
    const eps = before * 0.01; // 1 % Rauschband
    trend = d > eps ? 1 : d < -eps ? -1 : 0;
  }
  return { hasData: true, total, trend, refIso, trendBooks: common.size };
}
