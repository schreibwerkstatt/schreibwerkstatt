// Pro-Buch-Ziele + Fertigstellungs-Prognose. Facade: cards/my-stats-compute.js.
// Regeln: docs/my-stats.md „Bücher & Ziele / Prognose".

import { localIsoDate, localIsoDaysAgo } from '../../utils.js';
import { isoAddDays, isoDayDiff, latestSnapshotPerBook, earliestSnapshotPerBook,
         snapshotPerBookOnOrBefore } from './series.js';

// Fenster (Tage) fuer die Tempo-Schaetzung der Fertigstellungs-Prognose: juengster
// Snapshot je Buch minus Snapshot ~30 Tage zuvor → Zeichen-Zuwachs pro Kalendertag.
export const FORECAST_PACE_DAYS = 30;
// Prognose nur ausweisen, wenn sie nicht ins Absurde laeuft (~14 Jahre).
const FORECAST_MAX_DAYS = 5000;

/**
 * Pro-Buch-Ziel-Uebersicht: „auf welchem Buch wie viel geschrieben + Ziel erreicht?".
 * `booksDetail` (aus /me/profile-stats): pro eigenem Buch der live geschriebene
 * Umfang (chars/words/pages) + die Ziel-Felder aus book_settings
 * (goal_target_chars = Gesamtziel, goal_deadline = Frist, daily_goal_chars =
 * Tagesziel) + `is_finished`. `historyRows` (book_stats_history) liefert die
 * Vortags-Snapshots fuer den Tagesziel-Fortschritt (heute geschrieben = Live-
 * Stand minus letzter Snapshot strikt vor heute, auf >= 0 geklemmt — gleiche
 * Regel wie der Heute-Ring der Buch-Uebersicht) und das Tempo der Prognose.
 * Es zaehlt nur, was Inhalt ODER ein gesetztes Gesamtziel hat. Status:
 *   'reached' | 'overdue' | 'due' (Frist laeuft) | 'open' (ohne Frist) | 'none'
 * Namen werden im Card via _bookName aufgeloest (Content-Store-Regel).
 */
export function computeBookGoals(booksDetail, historyRows = [], todayLocal = new Date()) {
  const isoToday = localIsoDate(new Date(todayLocal));
  // Basis-Snapshot je Buch = letzter Snapshot strikt vor heute.
  const baseSnap = snapshotPerBookOnOrBefore(historyRows, localIsoDaysAgo(1, new Date(todayLocal)));

  // Tempo-Basis: juengster Snapshot gegen den letzten on-or-before (heute −
  // FORECAST_PACE_DAYS). Ein juengeres Buch hat keinen so alten Snapshot —
  // dann zaehlt sein aeltester (kuerzeres Fenster, `paceDays` sagt wie lang).
  const paceLatest = latestSnapshotPerBook(historyRows);
  const pacePast = snapshotPerBookOnOrBefore(historyRows, localIsoDaysAgo(FORECAST_PACE_DAYS, new Date(todayLocal)));
  const paceEarliest = earliestSnapshotPerBook(historyRows);

  const rows = (booksDetail || []).map((b) => {
    const chars = Number(b.chars) || 0;
    const goal = Number(b.goal_target_chars) || 0;
    const hasGoal = goal > 0;
    const deadline = b.goal_deadline || null;
    const reached = hasGoal && chars >= goal;
    const daysRemaining = deadline ? isoDayDiff(isoToday, deadline) : null;

    let status;
    if (!hasGoal) status = 'none';
    else if (reached) status = 'reached';
    else if (deadline && daysRemaining < 0) status = 'overdue';
    else if (deadline) status = 'due';
    else status = 'open';

    // Tagesziel: heute geschriebene Zeichen vs. daily_goal_chars. Ohne
    // Vortags-Snapshot kein verlaesslicher Tagesstand → 0 (analog today-ring.js).
    const dailyGoal = Number(b.daily_goal_chars) || 0;
    const hasDailyGoal = dailyGoal > 0;
    const prevChars = baseSnap.has(b.book_id) ? (Number(baseSnap.get(b.book_id).chars) || 0) : null;
    const charsToday = prevChars == null ? 0 : Math.max(0, chars - prevChars);

    // ── Fertigstellungs-Prognose ─────────────────────────────────────────────
    const latestSnap = paceLatest.get(b.book_id);
    const pastSnap = pacePast.get(b.book_id) || paceEarliest.get(b.book_id);
    let recentDailyChars = 0, paceDays = null;
    if (latestSnap && pastSnap && latestSnap.recorded_at > pastSnap.recorded_at) {
      paceDays = Math.max(1, isoDayDiff(pastSnap.recorded_at, latestSnap.recorded_at));
      recentDailyChars = Math.max(0, ((Number(latestSnap.chars) || 0) - (Number(pastSnap.chars) || 0)) / paceDays);
    }
    const remainingChars = hasGoal ? Math.max(0, goal - chars) : 0;
    let forecastDate = null, forecastStalled = false, forecastDays = null, onTrack = null;
    if (hasGoal && !reached) {
      if (recentDailyChars > 0) {
        const days = Math.ceil(remainingChars / recentDailyChars);
        if (days <= FORECAST_MAX_DAYS) {
          forecastDays = days;
          forecastDate = isoAddDays(isoToday, days);
          if (deadline) onTrack = forecastDate <= deadline;
        } else {
          forecastStalled = true;
        }
      } else {
        forecastStalled = true;
      }
    }
    // Bei laufender Frist: noetiges Tempo, um sie noch zu halten (>= 1 Tag).
    const requiredPerDay = (hasGoal && !reached && deadline && daysRemaining != null && daysRemaining >= 0)
      ? Math.ceil(remainingChars / Math.max(1, daysRemaining))
      : null;

    return {
      book_id: b.book_id,
      isFinished: !!b.is_finished,
      category: b.category || null,
      chars,
      words: Number(b.words) || 0,
      pages: Number(b.pages) || 0,
      normpages: Math.round(chars / 1500),
      goal: hasGoal ? goal : null,
      goalNormpages: hasGoal ? Math.round(goal / 1500) : null,
      hasGoal,
      reached,
      remainingChars: hasGoal ? remainingChars : null,
      // Fortschritt fuer den Balken auf 100 gedeckelt; pctRaw fuer die Zahl.
      pct: hasGoal ? Math.min(100, Math.round((chars / goal) * 100)) : null,
      pctRaw: hasGoal ? Math.round((chars / goal) * 100) : null,
      deadline,
      daysRemaining,
      status,
      // Fertigstellungs-Prognose.
      recentDailyChars: Math.round(recentDailyChars),
      paceDays,
      forecastDate,
      forecastDays,
      forecastStalled,
      requiredPerDay,
      onTrack,
      // Tagesziel-Block.
      charsToday,
      dailyGoalChars: hasDailyGoal ? dailyGoal : null,
      hasDailyGoal,
      dailyReached: hasDailyGoal && charsToday >= dailyGoal,
      dailyPct: hasDailyGoal ? Math.min(100, Math.round((charsToday / dailyGoal) * 100)) : null,
    };
  }).filter(r => r.chars > 0 || r.hasGoal);

  // Default: Buecher mit Ziel zuerst (nach Fortschritt absteigend), dann der
  // Rest nach Umfang. sortableTable kann im UI umsortieren.
  rows.sort((a, b) => {
    if (a.hasGoal !== b.hasGoal) return a.hasGoal ? -1 : 1;
    if (a.hasGoal) return (b.pctRaw || 0) - (a.pctRaw || 0);
    return b.chars - a.chars;
  });
  return rows;
}
