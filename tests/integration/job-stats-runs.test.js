'use strict';
// Integration: Job-Statistik der Kachel «KI-Jobs» in «Meine Statistik»
// (routes/jobs/shared/router.js). `/jobs/stats` und `/jobs/runs` filtern auf
// die Läufe des angemeldeten Users; `book_id` grenzt optional auf ein Buch ein.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const ME = 'jobstats-me@test.dev';
const OTHER = 'jobstats-other@test.dev';

let db; let server; let baseUrl;

async function get(path, user = ME) {
  const r = await fetch(baseUrl + path, { headers: { 'x-test-user': user } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function run(jobId, bookId, user, status = 'done') {
  db.prepare(`INSERT INTO job_runs (job_id, type, book_id, user_email, status, queued_at, started_at, ended_at, tokens_in, tokens_out)
              VALUES (?, 'review', ?, ?, ?, ?, ?, ?, 100, 50)`)
    .run(jobId, bookId, user, status, '2026-01-01T10:00:00.000Z', '2026-01-01T10:00:00.000Z', `2026-01-01T10:0${jobId.slice(-1)}:00.000Z`);
}

test.before(async () => {
  bootstrap();
  db = require('../../db/schema').db;
  for (const u of [ME, OTHER]) db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(u);
  for (const id of [8801, 8802]) {
    db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
      .run(id, `Buch ${id}`, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ME);
  }
  run('js-1', 8801, ME);
  run('js-2', 8802, ME, 'error');
  run('js-3', 8801, OTHER);
  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.headers['x-test-user'] || ME } }; next(); });
  app.use('/jobs', require('../../routes/jobs/shared/router').sharedRouter);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test('/jobs/runs ohne Buch: alle eigenen Läufe des Typs, mit bookId, nie fremde', async () => {
  const r = await get('/jobs/runs?type=review');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.map(x => x.jobId).sort(), ['js-1', 'js-2']);
  assert.deepEqual(r.body.map(x => x.bookId).sort(), [8801, 8802]);
});

test('/jobs/runs mit Buch grenzt ein; ohne Typ 400', async () => {
  const r = await get('/jobs/runs?type=review&book_id=8801');
  assert.deepEqual(r.body.map(x => x.jobId), ['js-1']);
  const bad = await get('/jobs/runs?book_id=8801');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error_code, 'TYPE_REQUIRED');
});

test('/jobs/stats: alle Bücher vs. ein Buch, nur eigene Läufe', async () => {
  const all = await get('/jobs/stats');
  const row = all.body.find(x => x.type === 'review');
  assert.equal(row.count, 1);
  assert.equal(row.errorCount, 1);
  const one = await get('/jobs/stats?book_id=8802');
  assert.equal(one.body.find(x => x.type === 'review').errorCount, 1);
  assert.equal(one.body.find(x => x.type === 'review').count, 0);
});
