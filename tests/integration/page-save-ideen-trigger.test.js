'use strict';
// PUT /content/pages/:id: nur ein Text-Write stellt den Ideen-Auto-Check
// (routes/jobs/ideen-auto-check.js#noteIdeenPageSave). Umbenennen/Verschieben
// ändert den Text nicht und darf keinen KI-Call auslösen.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Auslöser abfangen, BEVOR routes/content ihn destrukturiert.
const autoCheck = require('../../routes/jobs/ideen-auto-check');
const calls = [];
autoCheck.noteIdeenPageSave = (pageId) => { calls.push(pageId); };

const { bootstrap } = require('./_helpers/setup');

const ME = 'autorin@test.dev';
const BOOK = 9411;
const PAGE = 94111;
const NOW = '2026-01-01T00:00:00.000Z';

let ctx, db, server, baseUrl;

async function put(body) {
  const res = await fetch(`${baseUrl}/content/pages/${PAGE}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return res.status;
}

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { email: ME } }; next(); });
  app.use('/content', require('../../routes/content'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
  db.prepare('INSERT OR IGNORE INTO app_users (email, created_at) VALUES (?, ?)').run(ME, NOW);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(BOOK, 'Roman', NOW, NOW);
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, position, updated_at, body_html)
              VALUES (?, ?, 'Abschnitt', 0, ?, '<p>alt</p>')`).run(PAGE, BOOK, NOW);
  require('../../db/book-access').grantAccess(BOOK, ME, 'owner', ME);
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

test('Umbenennen stellt keinen Ideen-Auto-Check', async () => {
  calls.length = 0;
  assert.equal(await put({ name: 'Neuer Name' }), 200);
  assert.deepEqual(calls, []);
});

test('Text-Write stellt den Ideen-Auto-Check', async () => {
  calls.length = 0;
  assert.equal(await put({ html: '<p>neu</p>' }), 200);
  assert.deepEqual(calls, [PAGE]);
});
