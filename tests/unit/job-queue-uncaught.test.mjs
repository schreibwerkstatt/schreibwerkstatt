// Job-Queue (routes/jobs/shared/queue.js): ein Fehler, der am try/catch des
// Job-Moduls vorbeigeht (viele run*Job rufen `await getPrompts()` VOR ihrem try),
// muss den Job terminal auf 'error' setzen. Sonst bleibt er ewig 'running', der
// Dedup-Slot belegt, und der Client pollt einen Job, der nie endet.
//
// Lauf: `node --test tests/unit/job-queue-uncaught.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
process.env.DB_PATH = path.join(os.tmpdir(), `job-queue-test-${process.pid}-${Date.now()}.db`);
delete process.env.ADMIN_EMAIL;
require('../../db/migrations');
const { createJob, enqueueJob, jobs } = require('../../routes/jobs/shared');

async function waitFor(pred, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('async-Fehler ausserhalb des Job-try → Job endet als error', async () => {
  const id = createJob('test-uncaught', null, null, 'x');
  enqueueJob(id, async () => { await Promise.resolve(); throw new Error('prompts kaputt'); });
  await waitFor(() => jobs.get(id)?.status === 'error');
  assert.equal(jobs.get(id).error, 'prompts kaputt');
});

test('synchroner Throw in fn → Job endet als error, Queue laeuft weiter', async () => {
  const id = createJob('test-sync-throw', null, null, 'x');
  enqueueJob(id, () => { throw new Error('sync'); });
  await waitFor(() => jobs.get(id)?.status === 'error');
  const id2 = createJob('test-after', null, null, 'x');
  let ran = false;
  enqueueJob(id2, async () => { ran = true; });
  await waitFor(() => ran);
});

test('bereits terminal verbuchter Job wird nicht ueberschrieben', async () => {
  const { failJob } = require('../../routes/jobs/shared');
  const id = createJob('test-terminal', null, null, 'x');
  enqueueJob(id, async () => { failJob(id, new Error('erstes')); throw new Error('zweites'); });
  await waitFor(() => jobs.get(id)?.status === 'error');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(jobs.get(id).error, 'erstes');
});
