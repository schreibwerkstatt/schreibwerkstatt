'use strict';
// Unit: P6 als Endphase der Komplettanalyse (phases/beziehungen-zeitstrahl.js#runZeitstrahlPhase)
// darf den gespeicherten Katalog nicht kippen — Fehler werden zur Warnung
// `job.warn.timelineFailed`, nur AbortError schlägt durch; abgewählt läuft gar nichts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('komplett-zeitstrahl-phase');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
require('../../db/migrations').runMigrations();

const zt = require('../../routes/jobs/komplett/phases/beziehungen-zeitstrahl');

function makeCtx() {
  const warnings = [];
  return { warnings, ctx: { jobId: 'job-zt', bookIdInt: 1, email: 'u@test.dev', warnings, log: { info() {}, warn() {}, error() {} } } };
}

// Den Fehlerfall erzwingt ein ctx, dessen Buch-id beim Lesen wirft — runZeitstrahl liest
// sie als Erstes; so braucht der Test keinen Stub der Phase.
test('Zeitstrahl wirft → Warnung statt Abbruch', async () => {
  const { ctx, warnings } = makeCtx();
  await zt.runZeitstrahlPhase({ ...ctx, get bookIdInt() { throw new Error('kaputt'); } });
  assert.ok(warnings.some(w => w.key === 'job.warn.timelineFailed'));
});

test('Zeitstrahl abgewählt → kein Aufruf, keine Warnung', async () => {
  const { ctx, warnings } = makeCtx();
  await zt.runZeitstrahlPhase({ ...ctx, get bookIdInt() { throw new Error('darf nicht gelesen werden'); } }, { skip: true });
  assert.equal(warnings.length, 0);
});

test('AbortError schlägt durch', async () => {
  const { ctx } = makeCtx();
  const abort = Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
  await assert.rejects(zt.runZeitstrahlPhase({ ...ctx, get bookIdInt() { throw abort; } }), { name: 'AbortError' });
});
