'use strict';
// Tagebuch-spezifische Server-Regeln:
//   - POST /jobs/rueckblick nur für Buchtyp 'tagebuch' (400 NOT_DIARY_BOOK sonst)
//   - DELETE /history/book/:id leert auch den Rückblick-Endergebnis-Cache
//   - GET /content/books meldet für ein Buch ohne Settings-Zeile denselben
//     Buchtyp-Fallback (User-Default) wie getBookSettings

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
const ME = 'autor@test.dev';
const NOW = '2026-01-01T00:00:00.000Z';

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: ME } }; next(); });
    app.use('/jobs', require('../../routes/jobs/rueckblick').rueckblickRouter);
    app.use('/history', require('../../routes/history'));
    app.use('/content', require('../../routes/content'));
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function api(method, urlPath, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${urlPath}`, opts);
  let json = null;
  try { json = await res.json(); } catch (_) { /* leerer Body ist erlaubt */ }
  return { status: res.status, json };
}

function seedBook(bookId, buchtyp) {
  const { grantAccess } = require('../../db/book-access');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(bookId, `Buch ${bookId}`, NOW, NOW);
  grantAccess(bookId, ME, 'owner', ME);
  if (buchtyp) {
    db.prepare(`INSERT INTO book_settings (book_id, language, region, updated_at, buchtyp)
                VALUES (?, 'de', 'CH', ?, ?)`).run(bookId, NOW, buchtyp);
  }
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
  for (const t of ['tagebuch_rueckblick_cache', 'tagebuch_rueckblicke', 'pages', 'chapters',
    'book_settings', 'book_access', 'books']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare(`INSERT INTO app_users (email, global_role, created_at) VALUES (?, 'user', ?)
              ON CONFLICT(email) DO UPDATE SET default_buchtyp = NULL`).run(ME, NOW);
});

test('POST /jobs/rueckblick: Roman antwortet 400 NOT_DIARY_BOOK', async () => {
  seedBook(9401, 'roman');
  const r = await api('POST', '/jobs/rueckblick', { book_id: 9401, zeitraum: '2024-03' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'NOT_DIARY_BOOK');
});

test('POST /jobs/rueckblick: Buch ohne Buchtyp antwortet ebenfalls 400', async () => {
  seedBook(9402, null);
  const r = await api('POST', '/jobs/rueckblick', { book_id: 9402, zeitraum: '2024' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'NOT_DIARY_BOOK');
});

test('DELETE /history/book/:id leert den Rückblick-Cache des Users', async () => {
  seedBook(9403, 'tagebuch');
  const { saveRueckblickCache, loadRueckblickCache } = require('../../db/schema');
  saveRueckblickCache(9403, ME, '2024-03', 'sig', { zusammenfassung: 'x' }, 'claude');
  saveRueckblickCache(9403, 'fremd@test.dev', '2024-03', 'sig', { zusammenfassung: 'y' }, 'claude');
  assert.ok(loadRueckblickCache(9403, ME, '2024-03', 'sig', 'claude'));

  const r = await api('DELETE', '/history/book/9403');
  assert.equal(r.status, 200);
  assert.equal(loadRueckblickCache(9403, ME, '2024-03', 'sig', 'claude'), null, 'eigener Cache weg');
  assert.ok(loadRueckblickCache(9403, 'fremd@test.dev', '2024-03', 'sig', 'claude'), 'fremder Cache bleibt');
});

test('GET /content/books: ohne Settings-Zeile gilt der Default-Buchtyp des Users', async () => {
  seedBook(9404, null);
  seedBook(9405, 'roman');
  db.prepare('UPDATE app_users SET default_buchtyp = ? WHERE email = ?').run('tagebuch', ME);
  const r = await api('GET', '/content/books');
  assert.equal(r.status, 200);
  const byId = new Map(r.json.map(b => [b.id, b]));
  assert.equal(byId.get(9404)?.buchtyp, 'tagebuch', 'Fallback wie getBookSettings');
  assert.equal(byId.get(9405)?.buchtyp, 'roman', 'gesetzter Typ gewinnt');
  const { getBookSettings } = require('../../db/schema');
  assert.equal(getBookSettings(9404, ME).buchtyp, byId.get(9404).buchtyp);
});
