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

test('vor 23 Uhr lokal → gestern (lokal)', () => {
  // 2026-07-10 20:30 UTC = 22:30 CEST
  assert.equal(catchUpCutoff(new Date('2026-07-10T20:30:00Z'), TZ), '2026-07-09');
});

test('ab 23 Uhr lokal → heute (lokal), obwohl UTC noch 21 Uhr ist', () => {
  // 2026-07-10 21:15 UTC = 23:15 CEST
  assert.equal(catchUpCutoff(new Date('2026-07-10T21:15:00Z'), TZ), '2026-07-10');
});

test('nach lokaler Mitternacht, UTC noch am Vortag → lokales Gestern', () => {
  // 2026-07-10 22:30 UTC = 2026-07-11 00:30 CEST → letzter Lauf war 2026-07-10
  assert.equal(catchUpCutoff(new Date('2026-07-10T22:30:00Z'), TZ), '2026-07-10');
});

test('Monatswechsel und Jahreswechsel', () => {
  assert.equal(catchUpCutoff(new Date('2026-03-01T08:00:00Z'), TZ), '2026-02-28');
  assert.equal(catchUpCutoff(new Date('2027-01-01T08:00:00Z'), TZ), '2026-12-31');
});
