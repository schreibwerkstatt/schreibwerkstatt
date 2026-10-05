'use strict';
// Unit: P8 (routes/jobs/komplett/phases/kontinuitaet.js) darf die Komplettanalyse nicht
// kippen — ein Fehler der Verify-Stufe oder beim Speichern wird zur Warnung
// `job.warn.continuityFailed`, nur AbortError schlägt durch.
// Verify/Attribut-Detektor/Speichern sind gestubbt; der P8-Call liefert ein festes Ergebnis.

const test = require('node:test');
const assert = require('node:assert/strict');
const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('komplett-p8-nonfatal');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
require('../../db/migrations').runMigrations();

const remap = require('../../routes/jobs/komplett/remap');
const jobShared = require('../../routes/jobs/komplett/job-shared');

const stubs = { verify: null, save: null, attr: async () => [] };
remap.saveKontinuitaetResult = (...a) => stubs.save(...a);
jobShared.verifyKontinuitaetProbleme = (...a) => stubs.verify(...a);
jobShared.runAttributeContradictionCheck = (...a) => stubs.attr(...a);
delete require.cache[require.resolve('../../routes/jobs/komplett/phases/kontinuitaet')];
const { runKontinuitaetPhase } = require('../../routes/jobs/komplett/phases/kontinuitaet');

const RESULT = { zusammenfassung: 's', probleme: [{ typ: 'figur', beschreibung: 'b', kapitel: ['K1'] }] };

function makeCtx() {
  const warnings = [];
  const logs = [];
  const log = { info: () => {}, warn: (m) => logs.push(m), error: () => {} };
  return {
    warnings, logs,
    ctx: {
      jobId: 'job-p8', bookIdInt: 1, bookName: 'B', email: 'u@test.dev',
      call: async () => RESULT, tok: { in: 0, out: 0 }, log, effectiveProvider: 'claude',
      prompts: { buildKontinuitaetCheckPrompt: () => 'p', SCHEMA_KONTINUITAET_PROBLEME: {} },
      sys: { SYSTEM_KONTINUITAET_BLOCKS: [] },
      pageContents: [], fullBookText: '', warnings, idMaps: { chNameToId: {} },
    },
  };
}

const OPTS = {
  skipContinuity: false, skipZeitstrahl: true, isCloudModel: true, kontMultiPass: true,
  figKompakt: [], orteKompakt: [], chapterFakten: [], anachronismus: null, figNameToId: {},
};

test('Verify-Stufe wirft → Warnung, kein Speichern, kein Throw', async () => {
  let saved = 0;
  stubs.verify = async () => { throw new Error('verify kaputt'); };
  stubs.save = () => { saved++; };
  const { ctx, warnings } = makeCtx();
  await runKontinuitaetPhase(ctx, OPTS);
  assert.deepEqual(warnings, [{ key: 'job.warn.continuityFailed' }]);
  assert.equal(saved, 0, 'ungeprüftes Multi-Pass-Ergebnis wird nicht gespeichert');
});

test('Speichern wirft → Warnung, kein Throw', async () => {
  stubs.verify = async (_c, r) => r;
  stubs.save = () => { throw new TypeError('kaputter Befund'); };
  const { ctx, warnings } = makeCtx();
  await runKontinuitaetPhase(ctx, OPTS);
  assert.deepEqual(warnings, [{ key: 'job.warn.continuityFailed' }]);
});

test('Speichern der Attribut-Befunde allein wirft → Warnung, kein Throw', async () => {
  stubs.verify = async () => { throw new Error('verify kaputt'); };
  stubs.attr = async () => [{ typ: 'figur', _source: 'attr' }];
  stubs.save = () => { throw new Error('db'); };
  const { ctx, warnings } = makeCtx();
  await runKontinuitaetPhase(ctx, OPTS);
  assert.deepEqual(warnings, [{ key: 'job.warn.continuityFailed' }, { key: 'job.warn.continuityFailed' }]);
  stubs.attr = async () => [];
});

test('AbortError in der Verify-Stufe schlägt durch', async () => {
  stubs.verify = async () => { const e = new Error('abort'); e.name = 'AbortError'; throw e; };
  stubs.save = () => {};
  const { ctx } = makeCtx();
  await assert.rejects(runKontinuitaetPhase(ctx, OPTS), { name: 'AbortError' });
});
