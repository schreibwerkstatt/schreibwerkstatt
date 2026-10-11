'use strict';
// «Letzter Lauf» überlebt die job_runs-Aufbewahrung (`app.job_runs_retention_days`, lib/cache-cleanup.js):
// db/job-runs.js#lastDoneJobRun fällt auf das Kostenbuch zurück — aber nur für Läufe
// vor der ältesten job_runs-Zeile, denn das Kostenbuch kennt keinen Status.

const test = require('node:test');
const assert = require('node:assert');
const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('last-done-job-run');

const { db } = require('../../db/connection');
require('../../db/migrations');
const { lastDoneJobRun } = require('../../db/job-runs');

const EMAIL = 'a@b.ch';
db.prepare(`INSERT INTO app_users (email) VALUES (?)`).run(EMAIL);
db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (1, 'B', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();

function ledger(jobId, ts, usd) {
  db.prepare(`INSERT INTO ai_cost_ledger (ts, user_email, source, type, book_id, usd, source_ref)
              VALUES (?, ?, 'job', 'komplett-analyse', 1, ?, ?)`).run(ts, EMAIL, usd, `job:${jobId}`);
}
function run(jobId, status, at) {
  db.prepare(`INSERT INTO job_runs (job_id, type, book_id, user_email, status, queued_at, started_at, ended_at)
              VALUES (?, 'komplett-analyse', 1, ?, ?, ?, ?, ?)`).run(jobId, EMAIL, status, at, at, at);
}

test('ohne job_runs-Zeile: Lauf aus dem Kostenbuch', () => {
  ledger('alt', '2026-08-02T11:00:00.000Z', 61.2);
  run('fremd', 'done', '2026-09-20T00:00:00.000Z'); // älteste job_runs-Zeile
  db.prepare(`UPDATE job_runs SET type = 'review' WHERE job_id = 'fremd'`).run();
  const r = lastDoneJobRun('komplett-analyse', 1, EMAIL);
  assert.equal(r.job_id, 'alt');
  assert.equal(r.ended_at, '2026-08-02T11:00:00.000Z');
  assert.equal(r.started_at, null);
  assert.equal(r.usd, 61.2);
});

test('Kostenbuch-Zeile innerhalb der Aufbewahrung ohne done-Lauf zählt nicht', () => {
  ledger('kaputt', '2026-10-01T00:00:00.000Z', 5);
  run('kaputt', 'error', '2026-10-01T00:00:00.000Z');
  assert.equal(lastDoneJobRun('komplett-analyse', 1, EMAIL).job_id, 'alt');
});

test('erfolgreicher Lauf in job_runs geht vor', () => {
  run('neu', 'done', '2026-10-05T00:00:00.000Z');
  const r = lastDoneJobRun('komplett-analyse', 1, EMAIL);
  assert.equal(r.job_id, 'neu');
  assert.equal(r.started_at, '2026-10-05T00:00:00.000Z');
});
