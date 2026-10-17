'use strict';
// Fail-closed-Sanitizer an den Page-Routen: scheitert cleanPageHtml, antworten
// PUT /content/pages/:id, POST /content/pages, POST /content/pages/:id/split
// und der Fassungs-Restore mit `422 { error_code: 'HTML_SANITIZE_FAILED' }`
// (Client zeigt t('error.HTML_SANITIZE_FAILED')) — nicht mit CONTENT_FAILED.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Sanitizer-Wurf simulieren, BEVOR der Content-Store ihn destrukturiert.
const htmlClean = require('../../lib/html-clean');
const origClean = htmlClean.cleanPageHtml;
htmlClean.cleanPageHtml = (h) => {
  if (typeof h === 'string' && h.includes('SANITIZER_BOOM')) throw new RangeError('Maximum call stack size exceeded');
  return origClean(h);
};

const { bootstrap } = require('./_helpers/setup');

const ME = 'autorin@test.dev';
const BOOK = 9401;
const PAGE = 94011;
const NOW = '2026-01-01T00:00:00.000Z';
const BOOM = '<p onclick="x">SANITIZER_BOOM</p>';

let ctx, db, server, baseUrl;

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: ME } }; next(); });
  app.use('/content', require('../../routes/content'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
  db.prepare('INSERT OR IGNORE INTO app_users (email, created_at) VALUES (?, ?)').run(ME, NOW);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(BOOK, 'Roman', NOW, NOW);
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, position, updated_at, body_html)
              VALUES (?, ?, 'Abschnitt', 0, ?, '<p>alt</p><p>zwei</p>')`).run(PAGE, BOOK, NOW);
  require('../../db/book-access').grantAccess(BOOK, ME, 'owner', ME);
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

const bodyOf = () => db.prepare('SELECT body_html FROM pages WHERE page_id = ?').get(PAGE).body_html;
const pageCount = () => db.prepare('SELECT COUNT(*) AS n FROM pages').get().n;

test('PUT /content/pages/:id → 422 HTML_SANITIZE_FAILED, nichts geschrieben', async () => {
  const before = bodyOf();
  const r = await api('PUT', `/content/pages/${PAGE}`, { html: BOOM });
  assert.equal(r.status, 422);
  assert.deepEqual(r.json, { error_code: 'HTML_SANITIZE_FAILED' });
  assert.equal(bodyOf(), before);
});

test('POST /content/pages → 422 HTML_SANITIZE_FAILED, keine Seite angelegt', async () => {
  const n = pageCount();
  const r = await api('POST', '/content/pages', { book_id: BOOK, name: 'Neu', html: BOOM });
  assert.equal(r.status, 422);
  assert.deepEqual(r.json, { error_code: 'HTML_SANITIZE_FAILED' });
  assert.equal(pageCount(), n);
});

test('POST /content/pages/:id/split → 422 HTML_SANITIZE_FAILED', async () => {
  const n = pageCount();
  const r = await api('POST', `/content/pages/${PAGE}/split`, {
    head_html: '<p>alt</p>', tail_html: BOOM, new_name: 'Teil 2',
  });
  assert.equal(r.status, 422);
  assert.deepEqual(r.json, { error_code: 'HTML_SANITIZE_FAILED' });
  assert.equal(pageCount(), n);
});

test('POST /content/pages/:id/revisions/:rev/restore → 422 HTML_SANITIZE_FAILED', async () => {
  const rev = db.prepare(`INSERT INTO page_revisions (page_id, book_id, body_html, source, created_at)
                          VALUES (?, ?, ?, 'main', ?)`).run(PAGE, BOOK, BOOM, NOW).lastInsertRowid;
  const r = await api('POST', `/content/pages/${PAGE}/revisions/${rev}/restore`, {});
  assert.equal(r.status, 422);
  assert.deepEqual(r.json, { error_code: 'HTML_SANITIZE_FAILED' });
});

test('i18n-Key error.HTML_SANITIZE_FAILED in beiden Locales', () => {
  assert.ok(require('../../public/js/i18n/de.json')['error.HTML_SANITIZE_FAILED']);
  assert.ok(require('../../public/js/i18n/en.json')['error.HTML_SANITIZE_FAILED']);
});
