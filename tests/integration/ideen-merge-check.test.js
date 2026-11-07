'use strict';
// Integration: Zusammenführen und Auto-Erledigt-Check der Ideen über HTTP.
//  - POST /ideen/:id/merge: Besitz, Selbst-Merge, fremde Quelle, Erfolg (Links
//    wandern, Quellen fallen), abgeschlossenes Ziel + offene Quelle → 400
//  - DELETE /ideen/:id/check-hint: nur eigene Idee; PATCH /ideen/:id mit Stufe
//    räumt den Hinweis ab
//  - GET /ideen/board trägt `auto_check`; PATCH /me/settings schaltet ihn
//  - POST /jobs/ideen-auto-check: Lektor → 403, unbekannter Abschnitt → 404

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const OWNER = 'merge-owner@test.dev';
const LEKTOR = 'merge-lektor@test.dev';
const OTHER = 'merge-other@test.dev';
const BOOK = 9533;
const PAGE = 953301;
const NOW = '2026-01-01T00:00:00.000Z';

let ctx; let db; let server; let baseUrl; let ideenDb; let ideenCheck;

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  ideenDb = require('../../db/ideen');
  ideenCheck = require('../../db/ideen-check');
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Mergebuch', ?, ?)").run(BOOK, NOW, NOW);
  db.prepare("INSERT INTO pages (page_id, book_id, page_name, body_html, updated_at) VALUES (?, ?, 'Abschnitt', '<p>Text</p>', ?)").run(PAGE, BOOK, NOW);
  const appUsers = require('../../db/app-users');
  for (const email of [OWNER, LEKTOR, OTHER]) {
    if (!db.prepare('SELECT 1 FROM app_users WHERE email = ?').get(email)) appUsers.createUser({ email, displayName: email });
  }
  const access = require('../../db/book-access');
  access.grantAccess(BOOK, OWNER, 'editor', OWNER);
  access.grantAccess(BOOK, LEKTOR, 'lektor', OWNER);
  access.grantAccess(BOOK, OTHER, 'editor', OWNER);

  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.get('x-user') || OWNER } }; next(); });
  app.use('/ideen', require('../../routes/ideen'));
  app.use('/me', require('../../routes/usersettings'));
  app.use('/jobs', require('../../routes/jobs/ideen-auto-check').ideenAutoCheckRouter);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

async function call(method, path, body, user = OWNER) {
  const r = await fetch(baseUrl + path, {
    method, headers: { 'Content-Type': 'application/json', 'x-user': user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await r.json(); } catch { /* leer */ }
  return { status: r.status, json };
}

const mk = (content, email = OWNER) => ideenDb.createIdee({ bookId: BOOK, pageId: PAGE, userEmail: email, content });

test('merge: Fehlerfälle und Erfolg', async () => {
  const keep = mk('Behalten');
  const dup = mk('Dublette');
  const foreign = mk('Fremd', OTHER);

  assert.equal((await call('POST', `/ideen/${keep}/merge`, { source_ids: [] })).json.error_code, 'MERGE_SOURCES_REQ');
  assert.equal((await call('POST', `/ideen/${keep}/merge`, { source_ids: [keep] })).json.error_code, 'MERGE_SELF');
  assert.equal((await call('POST', `/ideen/${keep}/merge`, { source_ids: [foreign] })).status, 404);
  assert.equal((await call('POST', `/ideen/${keep}/merge`, { source_ids: [dup] }, OTHER)).status, 404, 'fremdes Ziel');

  const ok = await call('POST', `/ideen/${keep}/merge`, { source_ids: [dup], content: 'Behalten + Dublette' });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.idee.content, 'Behalten + Dublette');
  assert.deepEqual(ok.json.removed_ids, [dup]);
  assert.equal(ideenDb.getIdee(dup), null);
  assert.ok(ideenDb.getIdee(foreign), 'fremde Idee unberührt');

  const closed = mk('Zu');
  ideenDb.updateIdee(closed, OWNER, { status: 'erledigt' });
  const open = mk('Offen');
  assert.equal((await call('POST', `/ideen/${closed}/merge`, { source_ids: [open] })).json.error_code, 'MERGE_TARGET_CLOSED');
});

test('check-hint: verwerfen nur für eigene Idee, Stufenwechsel räumt ab, Board trägt check_hint', async () => {
  const id = mk('Pendenz');
  ideenCheck.setHint(id, OWNER, { pageId: PAGE, beleg: 'Text', begruendung: 'steht da' });
  const board = await call('GET', `/ideen/board?book_id=${BOOK}`);
  const row = board.json.ideen.find(i => i.id === id);
  assert.equal(row.check_hint.beleg, 'Text');
  assert.equal(row.check_hint.page_name, 'Abschnitt');
  assert.ok(!('hint_beleg' in row), 'keine flachen Hinweis-Spalten');

  assert.equal((await call('DELETE', `/ideen/${id}/check-hint`, undefined, OTHER)).status, 404);
  const del = await call('DELETE', `/ideen/${id}/check-hint`);
  assert.equal(del.status, 200);
  assert.equal(del.json.check_hint, null);

  ideenCheck.setHint(id, OWNER, { pageId: PAGE, beleg: 'Text' });
  const patched = await call('PATCH', `/ideen/${id}`, { status: 'erledigt' });
  assert.equal(patched.json.check_hint, null);
});

test('Schalter: Board meldet auto_check, PATCH /me/settings schaltet', async () => {
  assert.equal((await call('GET', `/ideen/board?book_id=${BOOK}`)).json.auto_check, true, 'Default an');
  const off = await call('PATCH', '/me/settings', { ideen_auto_check: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.ideen_auto_check, false);
  assert.equal((await call('GET', `/ideen/board?book_id=${BOOK}`)).json.auto_check, false);
  assert.equal((await call('PATCH', '/me/settings', { ideen_auto_check: 'ja' })).status, 400);
  await call('PATCH', '/me/settings', { ideen_auto_check: true });
});

test('POST /jobs/ideen-auto-check: Lektor 403, unbekannter Abschnitt 404, ohne page_id 400', async () => {
  assert.equal((await call('POST', '/jobs/ideen-auto-check', { page_id: PAGE }, LEKTOR)).status, 403);
  assert.equal((await call('POST', '/jobs/ideen-auto-check', { page_id: 99999991 })).status, 404);
  assert.equal((await call('POST', '/jobs/ideen-auto-check', {})).status, 400);
});
