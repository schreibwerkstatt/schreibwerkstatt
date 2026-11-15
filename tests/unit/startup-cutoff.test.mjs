// Catch-up-Stichtag des Startup-Syncs (lib/startup.js#catchUpCutoff): Stunde und
// Datum kommen beide aus app.timezone. `book_stats_history.recorded_at` ist ein
// lokales Datum — ein Mix aus Server-Stunde und UTC-Datum verglich in einem
// UTC-Container gegen den falschen Tag.
//
// Lauf: `node --test tests/unit/startup-cutoff.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('startup-cutoff-test');
require('../../db/migrations');
const { catchUpCutoff } = require('../../lib/startup');

const TZ = 'Europe/Zurich';

test('nach dem 00:05-Lauf → gestern (lokal)', () => {
  // 2026-07-10 20:30 UTC = 22:30 CEST
  assert.equal(catchUpCutoff(new Date('2026-07-10T20:30:00Z'), TZ), '2026-07-09');
  // 2026-07-09 22:06 UTC = 2026-07-10 00:06 CEST
  assert.equal(catchUpCutoff(new Date('2026-07-09T22:06:00Z'), TZ), '2026-07-09');
});

test('vor dem 00:05-Lauf → vorgestern (lokal), obwohl UTC noch am Vortag ist', () => {
  // 2026-07-09 22:03 UTC = 2026-07-10 00:03 CEST → letzter fälliger Lauf schrieb 2026-07-08
  assert.equal(catchUpCutoff(new Date('2026-07-09T22:03:00Z'), TZ), '2026-07-08');
});

test('Monatswechsel und Jahreswechsel', () => {
  assert.equal(catchUpCutoff(new Date('2026-03-01T08:00:00Z'), TZ), '2026-02-28');
  assert.equal(catchUpCutoff(new Date('2027-01-01T08:00:00Z'), TZ), '2026-12-31');
});
