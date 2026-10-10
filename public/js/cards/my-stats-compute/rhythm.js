// Schreibrhythmus-Kennzahlen aus der Schreibzeit-Reihe `writing` (Rows
// { book_id, date, seconds }, ggf. mehrere Buecher pro Tag). Facade:
// cards/my-stats-compute.js. Definitionen: docs/my-stats.md „Schreibrhythmus".

import { localIsoDate } from '../../utils.js';
import { buildStreakGrid, STREAK_WEEKS } from '../../streak-grid.js';
import { isoAddDays, isoDayDiff, isoDowMon, secondsByDate } from './series.js';

/**
 * Serien-Kennzahlen ueber ALLE Tage einer Tageswert-Map (nicht nur ueber das
 * 52-Wochen-Raster): aktive Tage, laengste Serie, aktuelle Serie. Eine Serie
 * reisst an jedem Kalendertag ohne Treffer — auch an einem, der in der Map gar
 * nicht vorkommt (die writing-Reihe kennt nur aktive Tage). Die aktuelle Serie
 * endet heute oder gestern: ein heute noch offener Tag bricht sie nicht.
 *
 * @param {Map<string, number>} valueByIso  ISO-Tag → Wert
 * @param {string} isoToday
 * @param {(v:number) => boolean} [hit]  Treffer-Regel (Default: Wert > 0)
 */
export function computeStreakStats(valueByIso, isoToday, hit = (v) => v > 0) {
  const days = [...valueByIso.entries()].filter(([, v]) => hit(Number(v) || 0)).map(([iso]) => iso).sort();
  let longest = 0, run = 0, prev = null;
  for (const iso of days) {
    run = prev && isoDayDiff(prev, iso) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = iso;
  }
  const isHit = (iso) => hit(Number(valueByIso.get(iso)) || 0);
  let current = 0;
  let iso = isHit(isoToday) ? isoToday : isoAddDays(isoToday, -1);
  while (isHit(iso)) { current++; iso = isoAddDays(iso, -1); }
  return { activeDays: days.length, longestStreak: longest, currentStreak: current };
}

// Streak-Heatmap (52 Wochen × 7 Tage, GitHub-Stil) + Serien-Kennzahlen.
// Raster und Einfaerbung liegen in [public/js/streak-grid.js] (geteilt mit der
// Buch-Uebersicht). Zwei Reihen, zwei Geltungsbereiche:
//   - `writingRows` fuellt das Raster: immer die letzten 52 Wochen bis heute.
//     Die Raster-eigenen Werte stehen als `grid*` daneben (Heatmap-Zusammenfassung).
//   - `statsRows` (Default: dieselbe Reihe) liefert `currentStreak`/
//     `longestStreak`/`totalActiveDays` — die Karte gibt hier das gewaehlte
//     Zeitfenster hinein, damit die Zahlen zum Tagesschnitt (computeDerived)
//     und zum Meilenstein „Schreibtage" passen.
//
// Heisst bewusst NICHT `computeWritingStreak`: today-ring.js exportiert eine
// gleichnamige Funktion mit anderer Signatur und anderer Datenquelle (Zeichen
// statt Sekunden), und beide liegen gleichzeitig im Modulgraph.
export function computeWritingTimeStreak(writingRows, todayLocal = new Date(), statsRows = writingRows) {
  const secByDate = secondsByDate(writingRows);
  const grid = buildStreakGrid({
    valueForIso: (iso) => secByDate.get(iso) || 0,
    todayLocal,
    weeks: STREAK_WEEKS,
    decorate: (cell) => cell.future
      ? { seconds: null, minutes: null }
      : { seconds: cell.value, minutes: Math.round(cell.value / 60), active: cell.value > 0 },
  });
  const statsSec = statsRows === writingRows ? secByDate : secondsByDate(statsRows);
  const stats = computeStreakStats(statsSec, localIsoDate(new Date(todayLocal)));
  return {
    weeks: grid.weeks,
    weeksCount: grid.weeksCount,
    gridActiveDays: grid.totalActiveDays,
    gridCurrentStreak: grid.currentStreak,
    gridLongestStreak: grid.longestStreak,
    currentStreak: stats.currentStreak,
    longestStreak: stats.longestStreak,
    totalActiveDays: stats.activeDays,
  };
}

// Wochentags-Muster: Summe Schreibminuten je Wochentag (Mo..So).
// pct = Anteil am Maximum (fuer Balkenhoehe). days = Anzahl aktiver Tage je Dow.
export function computeWeekdayPattern(writingRows) {
  const secByDate = secondsByDate(writingRows);
  const sec = [0, 0, 0, 0, 0, 0, 0];   // Index 0 = Mo ... 6 = So
  const days = [0, 0, 0, 0, 0, 0, 0];
  for (const [iso, s] of secByDate) {
    if (s <= 0) continue;
    const idx = isoDowMon(iso);
    sec[idx] += s;
    days[idx] += 1;
  }
  const minutes = sec.map(s => Math.round(s / 60));
  const max = Math.max(1, ...minutes);
  return minutes.map((m, i) => ({
    dow: i,
    minutes: m,
    days: days[i],
    pct: Math.round((m / max) * 100),
  }));
}

// Abgeleitete Kennzahlen: Tagesschnitt, bester Tag, Schreibtempo. `activeDays`
// zaehlt dieselben Tage wie computeStreakStats (Sekunden > 0).
export function computeDerived(data, writingRows) {
  const secByDate = secondsByDate(writingRows);
  let activeDays = 0, bestSec = 0, bestDate = null, totalSec = 0;
  for (const [iso, s] of secByDate) {
    if (s <= 0) continue;
    activeDays += 1;
    totalSec += s;
    if (s > bestSec) { bestSec = s; bestDate = iso; }
  }
  const writingSeconds = Number(data?.writing_seconds) || 0;
  const chars = Number(data?.chars) || 0;
  return {
    activeDays,
    dailyAvgMin: activeDays > 0 ? Math.round((totalSec / 60) / activeDays) : 0,
    bestDayMin:  Math.round(bestSec / 60),
    bestDayDate: bestDate,
    // Schreibtempo: Zeichen pro Stunde reiner Schreibzeit (gesamt, nicht pro Tag).
    paceCharsPerHour: writingSeconds > 0 ? Math.round(chars / (writingSeconds / 3600)) : 0,
  };
}

// Meilenstein-Stufen pro Kategorie. Achieved = hoechste erreichte Stufe je
// Kategorie (ein Badge). Next = die naechste unerreichte Stufe insgesamt mit
// kleinstem relativem Abstand (Fortschrittsbalken).
const MILESTONE_TIERS = {
  chars:      [50000, 100000, 250000, 500000, 1000000],
  words:      [10000, 25000, 50000, 100000, 250000],
  activeDays: [10, 30, 100, 365],
  books:      [1, 3, 5, 10],
};

// `books` zaehlt nur Buecher mit Inhalt (books_detail.chars > 0): ein leer
// angelegtes Buch ist kein „1 Buch"-Meilenstein. Ohne books_detail faellt die
// Zaehlung auf `data.books` zurueck.
export function computeMilestones(data, derived) {
  const detail = Array.isArray(data?.books_detail) ? data.books_detail : null;
  const values = {
    chars:      Number(data?.chars) || 0,
    words:      Number(data?.words) || 0,
    activeDays: Number(derived?.activeDays) || 0,
    books:      detail ? detail.filter(b => (Number(b.chars) || 0) > 0).length : (Number(data?.books) || 0),
  };
  const achieved = [];
  let next = null; // { category, target, value, progress }
  for (const [cat, tiers] of Object.entries(MILESTONE_TIERS)) {
    const v = values[cat];
    let top = null, upcoming = null;
    for (const t of tiers) {
      if (v >= t) top = t;
      else { upcoming = t; break; }
    }
    if (top != null) achieved.push({ category: cat, target: top });
    if (upcoming != null) {
      const progress = Math.min(100, Math.round((v / upcoming) * 100));
      if (!next || progress > next.progress) next = { category: cat, target: upcoming, value: v, progress };
    }
  }
  return { achieved, next };
}

// Schreibzeit je Buch (absteigend) fuer das „wo deine Zeit hinfloss"-Ranking.
// pct relativ zum Spitzenbuch. Namen werden im Card via _bookName aufgeloest.
export function computePerBookTime(writingRows) {
  const secByBook = new Map();
  for (const r of (writingRows || [])) {
    secByBook.set(r.book_id, (secByBook.get(r.book_id) || 0) + (Number(r.seconds) || 0));
  }
  const rows = [...secByBook.entries()]
    .map(([book_id, seconds]) => ({ book_id, seconds, minutes: Math.round(seconds / 60) }))
    .filter(r => r.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
  const max = rows.length ? rows[0].seconds : 1;
  return rows.map(r => ({ ...r, pct: Math.round((r.seconds / max) * 100) }));
}

// Tageszeit-Muster: Schreibminuten je Stunde (0..23) aus dem lebenslangen
// writing_hour-Histogramm. Liefert immer 24 Buckets (auch leere) plus pct
// (Anteil am Maximum, fuer die Balkenhoehe). Rows: [{ hour, seconds }].
export function computeHourPattern(byHourRows) {
  const sec = new Array(24).fill(0);
  for (const r of (byHourRows || [])) {
    const h = Number(r.hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) continue;
    sec[h] += Number(r.seconds) || 0;
  }
  const minutes = sec.map(s => Math.round(s / 60));
  const max = Math.max(1, ...minutes);
  let peakHour = -1, peakMin = 0, total = 0;
  const hours = minutes.map((m, h) => {
    total += sec[h];
    if (m > peakMin) { peakMin = m; peakHour = h; }
    return { hour: h, seconds: sec[h], minutes: m, pct: Math.round((m / max) * 100) };
  });
  return { hours, peakHour: peakMin > 0 ? peakHour : null, totalSeconds: total, hasData: total > 0 };
}

// Tagesziel-Erreichung (Minuten/Tag). Quelle ist die Schreibzeit-Reihe; ein Tag
// gilt als erreicht, wenn seine Schreibsekunden >= Ziel·60 sind. `todaySeconds`
// ist der LIVE-Stand von heute (vom Server separat geliefert) und ueberschreibt
// den ggf. noch nicht geflushten Reihen-Wert. Serien ueber Kalendertage
// (computeStreakStats): ein Tag ohne Eintrag reisst die Serie.
export function computeGoalAttainment(writingRows, goalMinutes, todaySeconds = null, todayLocal = new Date()) {
  const goalMin = Math.max(0, Math.round(Number(goalMinutes) || 0));
  if (goalMin <= 0) return { active: false };
  const goalSec = goalMin * 60;

  const secByDate = secondsByDate(writingRows);
  const isoToday = localIsoDate(new Date(todayLocal));
  if (todaySeconds != null) secByDate.set(isoToday, Number(todaySeconds) || 0);

  const todaySec = secByDate.get(isoToday) || 0;
  const stats = computeStreakStats(secByDate, isoToday, (s) => s >= goalSec);

  return {
    active: true,
    goalMinutes: goalMin,
    todayMinutes: Math.round(todaySec / 60),
    progressPct: Math.min(100, Math.round((todaySec / goalSec) * 100)),
    reachedToday: todaySec >= goalSec,
    daysHit: stats.activeDays,
    currentStreak: stats.currentStreak,
    longestStreak: stats.longestStreak,
  };
}

// Aufwands-Aufteilung Schreiben vs. Ueberarbeiten (Sekunden → Prozent).
export function computeEffortSplit(writingSeconds, lektoratSeconds) {
  const w = Math.max(0, Number(writingSeconds) || 0);
  const l = Math.max(0, Number(lektoratSeconds) || 0);
  const total = w + l;
  return {
    writingSeconds: w,
    lektoratSeconds: l,
    hasData: total > 0,
    writingPct: total > 0 ? Math.round((w / total) * 100) : 0,
    lektoratPct: total > 0 ? Math.round((l / total) * 100) : 0,
  };
}
