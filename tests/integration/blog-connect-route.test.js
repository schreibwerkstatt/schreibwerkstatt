'use strict';
// Route-Test POST /blog/:book_id/connect — `__keep__` (oder leeres Passwort)
// darf das gespeicherte App-Passwort nur gegen dasselbe Ziel (URL + User)
// wiederverwenden. Sonst schickt `wp.me()` es an einen Host, den ein
// Mitautor frei waehlt.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.SSRF_SKIP_DNS_CHECK = '1';

const { bootstrap } = require('./_helpers/setup');

const OWNER = 'owner@test.dev';
const EDITOR = 'editor@test.dev';
const BOOK = 9411;
const NOW = '2026-01-01T00:00:00.000Z';

let ctx;
let db;
let blogs;
let server;
let baseUrl;
let realFetch;
const outbound = [];

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  blogs = require('../../db/blogs');
  realFetch = globalThis.fetch;
  // Lokale Requests an den Test-Server durchreichen, alles andere mitschreiben.
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith(baseUrl)) return realFetch(url, opts);
    outbound.push({ url: String(url), auth: opts?.headers?.Authorization });
    return { ok: false, status: 401, headers: { get: () => null }, text: async () => '', json: async () => ({}) };
  };
  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: EDITOR } }; next(); });
  app.use('/blog', require('../../routes/blog'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => {
  globalThis.fetch = realFetch;
  if (server) server.close();
  ctx.cleanup();
});

test.beforeEach(() => {
  outbound.length = 0;
  db.prepare('DELETE FROM blog_connections').run();
  db.prepare('DELETE FROM books').run();
  for (const u of [OWNER, EDITOR]) db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(u);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(BOOK, 'Blog', NOW, NOW);
  const { grantAccess } = require('../../db/book-access');
  grantAccess(BOOK, OWNER, 'owner', OWNER);
  grantAccess(BOOK, EDITOR, 'editor', OWNER);
  ctx.dbSchema.saveBookSettings(BOOK, 'de', 'CH', 'blog', null, null, null, 0, 0);
  blogs.upsertConnection({
    bookId: BOOK, baseUrl: 'https://wp.test', username: 'owner', password: 'geheim', defaultStatus: 'draft',
  });
});

async function connect(body) {
  const res = await realFetch(`${baseUrl}/blog/${BOOK}/connect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

for (const password of ['__keep__', '', undefined]) {
  test(`connect: neue URL mit Passwort ${JSON.stringify(password)} → 400, kein Request ans neue Ziel`, async () => {
    const r = await connect({ baseUrl: 'https://attacker.test', username: 'owner', password });
    assert.equal(r.status, 400);
    assert.equal(r.json.error_code, 'BLOG_PASSWORD_REQUIRED_TARGET_CHANGED');
    assert.equal(outbound.length, 0);
    assert.equal(blogs.getConnection(BOOK).baseUrl, 'https://wp.test');
  });
}

test('connect: neuer Benutzername mit __keep__ → 400', async () => {
  const r = await connect({ baseUrl: 'https://wp.test', username: 'jemand', password: '__keep__' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'BLOG_PASSWORD_REQUIRED_TARGET_CHANGED');
  assert.equal(outbound.length, 0);
});

test('connect: gleiches Ziel mit __keep__ nutzt das gespeicherte Passwort', async () => {
  await connect({ baseUrl: 'https://wp.test', username: 'owner', password: '__keep__' });
  assert.equal(outbound.length, 1);
  assert.match(outbound[0].url, /^https:\/\/wp\.test\//);
  assert.equal(outbound[0].auth, `Basic ${Buffer.from('owner:geheim').toString('base64')}`);
});
