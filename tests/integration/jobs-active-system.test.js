'use strict';
// GET /jobs/active für Buch-System-Jobs (embed-index, userEmail null): Suche und
// Buchlandkarte hängen sich an einen laufenden Index-Lauf. Mit der Session-E-Mail
// fände findActiveJobId ihn nie; dafür gilt die Buch-ACL (viewer).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { bootstrap } = require('./_helpers/setup');

const ME = 'autor@test.dev';
const STRANGER = 'fremd@test.dev';
const BOOK = 9401;
const NOW = '2026-01-01T00:00:00.000Z';

let ctx, server, baseUrl, currentUser = ME;

test.before(async () => {
  ctx = bootstrap();
  const { db } = require('../../db/schema');
  for (const u of [ME, STRANGER]) db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(u);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(BOOK, 'Buch', NOW, NOW);
  require('../../db/book-access').grantAccess(BOOK, ME, 'viewer', ME);
  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: currentUser } }; next(); });
  app.use('/jobs', require('../../routes/jobs/shared').sharedRouter);
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

test('embed-index: laufender System-Job wird für Buch-Leser gefunden', async () => {
  const { createJob } = require('../../routes/jobs/shared');
  const jobId = createJob('embed-index', BOOK, null, 'job.label.embedIndex', null, BOOK);
  currentUser = ME;
  const r = await fetch(`${baseUrl}/jobs/active?type=embed-index&book_id=${BOOK}`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).jobId, jobId);

  currentUser = STRANGER;
  const denied = await fetch(`${baseUrl}/jobs/active?type=embed-index&book_id=${BOOK}`);
  assert.equal(denied.status, 403);
});
