// Pure Compute-Funktionen fuer „Meine Statistik" (my-stats-card.js) — Facade
// ueber cards/my-stats-compute/ (series, volume, rhythm, readability, goals).
// Bewusst frei von Alpine/DOM → unit-testbar (tests/unit/my-stats-compute.test.mjs).
// Kennzahl-Definitionen und Datenquellen: docs/my-stats.md.

export { isoAddDays, isoDayDiff, isoDowMon, bucketizeIso, bucketRange, aggregateByBucket,
         filterByWindow, secondsByDate, latestSnapshotPerBook, earliestSnapshotPerBook,
         snapshotPerBookOnOrBefore, firstSnapshotPerBookInWindow, resolveWindow } from './my-stats-compute/series.js';
export { computeVolumeDelta, computeWeeklyDelta, HISTORY_DAILY_DAYS } from './my-stats-compute/volume.js';
export { computeStreakStats, computeWritingTimeStreak, computeWeekdayPattern, computeDerived,
         computeMilestones, computePerBookTime, computeHourPattern, computeGoalAttainment,
         computeEffortSplit } from './my-stats-compute/rhythm.js';
export { computeReadability, commonBookIds, TREND_REF_DAYS } from './my-stats-compute/readability.js';
export { computeBookGoals, FORECAST_PACE_DAYS } from './my-stats-compute/goals.js';
