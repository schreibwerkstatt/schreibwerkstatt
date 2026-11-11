import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWeekBars, computeWritingStreak } from '../../public/js/today-ring.js';

// Kumulative Tages-Snapshots (recorded_at + chars = Buchstand am Tagesende).
// Heute (2026-07-04) hat keinen Snapshot — der Live-Wert kommt aus tokEsts.
const STATS = [
  { recorded_at: '2026-06-30', chars: 100 },
  { recorded_at: '2026-07-01', chars: 600 },   // Delta 500
  { recorded_at: '2026-07-02', chars: 1200 },  // Delta 600
  { recorded_at: '2026-07-03', chars: 1800 },  // Delta 600
];
const TODAY = '2026-07-04';

test('computeWeekBars: 7 Balken, aeltester zuerst, heute markiert', () => {
  const bars = computeWeekBars({ stats: STATS, tokEsts: { 1: { chars: 2400 } }, goalChars: 1500, todayIso: TODAY });
  assert.equal(bars.length, 7);
  assert.equal(bars[6].isToday, true);
  assert.equal(bars.slice(0, 6).every(b => !b.isToday), true);
  // 06-28, 06-29 → 0 | 06-30 ohne Vortagssnapshot → 0 | 07-01=500 | 07-02=600
  // | 07-03=600 | 07-04 heute live (2400-1800)=600.
  assert.deepEqual(bars.map(b => b.chars), [0, 0, 0, 500, 600, 600, 600]);
});

test('computeWeekBars: pct + reached gegen Ziel', () => {
  const bars = computeWeekBars({ stats: STATS, tokEsts: { 1: { chars: 3300 } }, goalChars: 1500, todayIso: TODAY });
  const today = bars[6];
  assert.equal(today.chars, 1500);       // 3300 - 1800
  assert.equal(today.pct, 100);
  assert.equal(today.reached, true);
  assert.equal(today.goalPct, 100);
});

test('computeWeekBars: Tage ueber dem Ziel skalieren am besten Tag, nicht gekappt', () => {
  // Ziel 500, Tage 500/600/600 + heute 1500 → Skala 1500.
  const bars = computeWeekBars({ stats: STATS, tokEsts: { 1: { chars: 3300 } }, goalChars: 500, todayIso: TODAY });
  assert.deepEqual(bars.map(b => b.pct), [0, 0, 0, 33, 40, 40, 100]);
  assert.equal(bars[0].goalPct, 33);
  assert.equal(bars.slice(3).every(b => b.reached), true);
});

test('computeWritingStreak: aufeinanderfolgende Schreibtage', () => {
  // heute 600 (2400-1800) → 07-04,03,02,01 alle >0, 06-30-Delta=0 bricht ab.
  const s = computeWritingStreak({ stats: STATS, tokEsts: { 1: { chars: 2400 } }, todayIso: TODAY });
  assert.equal(s, 4);
});

test('computeWritingStreak: heute==0 bricht die Serie nicht (Kulanz)', () => {
  // Live == letzter Snapshot → heute-Delta 0; Serie zaehlt ab gestern.
  const s = computeWritingStreak({ stats: STATS, tokEsts: { 1: { chars: 1800 } }, todayIso: TODAY });
  assert.equal(s, 3);   // 07-03, 07-02, 07-01
});

test('computeWritingStreak: keine Daten → 0', () => {
  assert.equal(computeWritingStreak({ stats: [], tokEsts: {}, todayIso: TODAY }), 0);
});
