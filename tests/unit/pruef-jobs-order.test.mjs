// Prüf-Jobs nach der Komplettanalyse (routes/jobs/komplett/pruef-jobs.js): Erzählprofil
// und Kontinuität schicken das ganze Buch als denselben geteilten 1h-Block. Parallel
// gestartet schriebe jeder ihn selbst in den Cache (~500 K Tokens bei einem Roman);
// darum startet die Kontinuität erst, wenn das Erzählprofil terminal ist — und gar
// nicht, wenn sie in der Wartezeit abgebrochen wurde.
//
// Lauf: `node --test tests/unit/pruef-jobs-order.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('pruef-jobs-order');
delete process.env.ADMIN_EMAIL;
require('../../db/migrations');
const appSettings = require('../../lib/app-settings');
const shared = require('../../routes/jobs/shared');
const { jobs, completeJob, failJob, cancelJob } = shared;

// Stub-Runner statt der echten Jobs (die laden Buchinhalte und rufen die KI).
const started = [];
const releases = new Map();
function stubModule(rel, name, type) {
  const path = require.resolve(rel);
  require.cache[path] = {
    id: path, filename: path, loaded: true,
    exports: {
      [name]: (jobId) => {
        started.push(type);
        return new Promise((resolve) => releases.set(jobId, resolve));
      },
    },
  };
}
stubModule('../../routes/jobs/komplett/job-erzaehlprofil', 'runErzaehlprofilJob', 'erzaehlprofil');
stubModule('../../routes/jobs/komplett/job-kontinuitaet', 'runKontinuitaetJob', 'kontinuitaet');
const { enqueuePruefJobs } = require('../../routes/jobs/komplett/pruef-jobs');

async function waitFor(pred, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
const tick = () => new Promise((r) => setTimeout(r, 20));
function finish(jobId, fn = () => completeJob(jobId, {})) {
  fn();
  releases.get(jobId)?.();
}

const SCOPE = { kontinuitaet: true, erzaehlprofil: true };

test('Kontinuität startet erst nach dem Ende des Erzählprofils', async () => {
  appSettings.set('jobs.max_concurrent', 4, { updatedBy: 'test@x' });
  started.length = 0;
  const ids = enqueuePruefJobs({ bookId: 11, bookName: 'B', userEmail: null, scope: SCOPE, provider: 'claude' });
  assert.ok(ids.erzaehlprofil && ids.kontinuitaet);
  await waitFor(() => started.includes('erzaehlprofil'));
  await tick();
  assert.deepEqual(started, ['erzaehlprofil'], 'Kontinuität wartet trotz freier Slots');
  assert.equal(jobs.get(ids.kontinuitaet).status, 'queued');
  finish(ids.erzaehlprofil);
  await waitFor(() => started.includes('kontinuitaet'));
  finish(ids.kontinuitaet);
});

test('gescheitertes Erzählprofil gibt die Kontinuität trotzdem frei', async () => {
  started.length = 0;
  const ids = enqueuePruefJobs({ bookId: 12, bookName: 'B', userEmail: null, scope: SCOPE, provider: 'claude' });
  await waitFor(() => started.includes('erzaehlprofil'));
  finish(ids.erzaehlprofil, () => failJob(ids.erzaehlprofil, new Error('boom')));
  await waitFor(() => started.includes('kontinuitaet'));
  finish(ids.kontinuitaet);
});

test('in der Wartezeit abgebrochene Kontinuität startet nicht mehr', async () => {
  started.length = 0;
  const ids = enqueuePruefJobs({ bookId: 13, bookName: 'B', userEmail: null, scope: SCOPE, provider: 'claude' });
  await waitFor(() => started.includes('erzaehlprofil'));
  assert.equal(cancelJob(ids.kontinuitaet, null), true);
  finish(ids.erzaehlprofil);
  await tick();
  assert.deepEqual(started, ['erzaehlprofil']);
  assert.equal(jobs.get(ids.kontinuitaet).status, 'cancelled');
});

test('nur Kontinuität im Umfang: startet sofort', async () => {
  started.length = 0;
  const ids = enqueuePruefJobs({ bookId: 14, bookName: 'B', userEmail: null, scope: { kontinuitaet: true }, provider: 'claude' });
  assert.equal(ids.erzaehlprofil, undefined);
  await waitFor(() => started.includes('kontinuitaet'));
  finish(ids.kontinuitaet);
});
