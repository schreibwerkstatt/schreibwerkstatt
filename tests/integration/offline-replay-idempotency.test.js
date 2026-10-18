'use strict';
// Idempotenz der Anlege-Requests, die die Offline-Warteschlangen nachspielen
// (lib/idempotency.js; public/js/repo/structure-queue.js, ideen-queue.js).
//
//   - Gleicher `Idempotency-Key` → dieselbe Antwort, nichts doppelt angelegt.
//   - Anderer Schlüssel / ohne Schlüssel → normal neu angelegt.
//   - Schlüssel gilt pro Konto: ein fremder User mit demselben Schlüssel
//     bekommt nicht die Antwort des anderen, und die Rechteprüfung läuft vorher.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
let sessionUser;

const ME = 'autorin@test.dev';
const OTHER = 'fremd@test.dev';
const BOOK = 9601;
const CHAPTER = 9611;
const T0 = '2026-01-01T00:00:00.000Z';

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => {
      req.session = { user: { email: sessionUser } };
      next();
    });
    app.use('/content', require('../../routes/content'));
    app.use('/ideen', require('../../routes/ideen'));
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function api(method, path, body, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null), replayed: res.headers.get('Idempotent-Replayed') };
}

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  await startServer();
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

test.beforeEach(() => {
  require('../../lib/idempotency')._resetIdempotency();
  sessionUser = ME;
  for (const t of ['idea_links', 'ideen', 'page_revisions', 'book_access', 'book_order']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare('DELETE FROM pages').run();
  db.prepare('DELETE FROM chapters').run();
  db.prepare('DELETE FROM books').run();
  for (const u of [ME, OTHER]) db.prepare('INSERT OR IGNORE INTO app_users (email, created_at) VALUES (?, ?)').run(u, T0);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(BOOK, 'Roman', T0, T0);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, 0, ?)')
    .run(CHAPTER, BOOK, 'Kapitel', T0);
  require('../../db/book-access').grantAccess(BOOK, ME, 'owner', ME);
});

const countPages = () => db.prepare('SELECT COUNT(*) AS n FROM pages WHERE book_id = ?').get(BOOK).n;
const countIdeen = () => db.prepare('SELECT COUNT(*) AS n FROM ideen WHERE book_id = ?').get(BOOK).n;

test('POST /content/pages: gleicher Schlüssel legt nicht doppelt an', async () => {
  const body = { chapter_id: CHAPTER, name: 'Offline', html: '<p>Text</p>' };
  const a = await api('POST', '/content/pages', body, 'op-aaaaaaaa-1');
  const b = await api('POST', '/content/pages', body, 'op-aaaaaaaa-1');
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(b.json.id, a.json.id);
  assert.equal(b.replayed, 'true');
  assert.equal(countPages(), 1);
  const c = await api('POST', '/content/pages', body, 'op-bbbbbbbb-2');
  assert.notEqual(c.json.id, a.json.id);
  await api('POST', '/content/pages', body);
  assert.equal(countPages(), 3, 'ohne Schlüssel wie bisher');
});

test('POST /ideen: gleicher Schlüssel legt nicht doppelt an', async () => {
  const body = { book_id: BOOK, chapter_id: CHAPTER, content: 'Einfall' };
  const a = await api('POST', '/ideen', body, 'op-cccccccc-3');
  const b = await api('POST', '/ideen', body, 'op-cccccccc-3');
  assert.equal(a.status, 200);
  assert.equal(b.json.id, a.json.id);
  assert.equal(countIdeen(), 1);
});

test('Schlüssel gilt pro Konto, Rechteprüfung läuft vorher', async () => {
  const body = { chapter_id: CHAPTER, name: 'Offline' };
  await api('POST', '/content/pages', body, 'op-dddddddd-4');
  sessionUser = OTHER;
  const r = await api('POST', '/content/pages', body, 'op-dddddddd-4');
  assert.equal(r.status, 403, 'kein Zugriff aufs Buch, keine fremde Antwort');
  assert.equal(countPages(), 1);
});

test('Ungültiger Schlüssel wird ignoriert', async () => {
  const body = { chapter_id: CHAPTER, name: 'Offline' };
  await api('POST', '/content/pages', body, 'x');
  await api('POST', '/content/pages', body, 'x');
  assert.equal(countPages(), 2);
});

// Client-Timeout: der Nachspiel-Request kommt, während der erste noch anlegt.
// Er wartet auf den ersten und bekommt dessen Antwort, statt doppelt anzulegen.
// `createPage` wird dafür künstlich verzögert (Facade-Methode, die die Route
// zur Laufzeit nachschlägt).
function slowCreatePage({ fail = false } = {}) {
  const store = require('../../lib/content-store');
  const orig = store.createPage;
  let calls = 0;
  store.createPage = async (...args) => {
    calls++;
    await new Promise((r) => setTimeout(r, 150));
    if (fail && calls === 1) { const e = new Error('kaputt'); e.status = 500; throw e; }
    return orig.apply(store, args);
  };
  return { calls: () => calls, restore: () => { store.createPage = orig; } };
}

test('POST /content/pages: Nachspiel während der erste noch läuft → eine Seite, gleiche Antwort', async () => {
  const slow = slowCreatePage();
  try {
    const body = { chapter_id: CHAPTER, name: 'Parallel' };
    const [a, b] = await Promise.all([
      api('POST', '/content/pages', body, 'op-eeeeeeee-5'),
      api('POST', '/content/pages', body, 'op-eeeeeeee-5'),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(b.json.id, a.json.id);
    assert.equal(countPages(), 1);
    assert.equal(slow.calls(), 1, 'nur der erste Request legt an');
  } finally { slow.restore(); }
});

test('POST /content/pages: scheitert der erste, legt der wartende selbst an', async () => {
  const slow = slowCreatePage({ fail: true });
  try {
    const body = { chapter_id: CHAPTER, name: 'Zweiter Versuch' };
    const [a, b] = await Promise.all([
      api('POST', '/content/pages', body, 'op-ffffffff-6'),
      api('POST', '/content/pages', body, 'op-ffffffff-6'),
    ]);
    assert.ok(a.status >= 500, `erster scheitert (${a.status})`);
    assert.equal(b.status, 200);
    assert.equal(b.replayed, null, 'keine Wiederholung einer gescheiterten Antwort');
    assert.equal(countPages(), 1);
    // Ein dritter Versuch bekommt die Antwort des zweiten.
    const c = await api('POST', '/content/pages', body, 'op-ffffffff-6');
    assert.equal(c.json.id, b.json.id);
    assert.equal(c.replayed, 'true');
  } finally { slow.restore(); }
});
