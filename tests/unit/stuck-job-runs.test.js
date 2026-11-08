'use strict';
// db/job-runs.js#cleanupStuckJobRuns: der Nacht-Cron räumt nur verwaiste Zeilen. Jobs, die
// der Prozess gerade ausführt oder in der Queue hält (`keepJobIds`), bleiben stehen — sonst
// stand eine über 23:00 laufende Komplettanalyse bis zu ihrem Ende als «gestorben» da.

const test = require('node:test');
const assert = require('node:assert');
const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('stuck-job-runs');

const { db } = require('../../db/connection');
require('../../db/migrations');
const { cleanupStuckJobRuns } = require('../../db/job-runs');

function run(jobId, status) {
  db.prepare(`INSERT INTO job_runs (job_id, type, status, queued_at) VALUES (?, 'komplett-analyse', ?, '2026-11-07T21:16:06.418Z')`)
    .run(jobId, status);
}
const statusOf = (jobId) => db.prepare('SELECT status FROM job_runs WHERE job_id = ?').get(jobId).status;

test('Cron: laufende und wartende Jobs des Prozesses bleiben, verwaiste werden error', () => {
  run('lebt', 'running');
  run('wartet', 'queued');
  run('tot', 'running');
  run('fertig', 'done');
  const n = cleanupStuckJobRuns({ keepJobIds: ['lebt', 'wartet'] });
  assert.equal(n, 1);
  assert.equal(statusOf('lebt'), 'running');
  assert.equal(statusOf('wartet'), 'queued');
  assert.equal(statusOf('tot'), 'error');
  assert.equal(statusOf('fertig'), 'done');
});

test('Boot: ohne keepJobIds wird jede offene Zeile error', () => {
  const n = cleanupStuckJobRuns();
  assert.equal(n, 2);
  assert.equal(statusOf('lebt'), 'error');
  assert.equal(statusOf('wartet'), 'error');
});
