'use strict';
// Einabschnitts-Kapitel an der Schreibroute (routes/ideen.js, lib/idee-anchor.js):
// ein Kapitel mit genau einem Abschnitt ist derselbe Ort wie dieser Abschnitt.
//   * POST /ideen mit chapter_id legt die Idee am Abschnitt an — auch für einen
//     älteren, noch gespeicherten Chat-Vorschlag am Kapitel.
//   * PATCH /ideen/:id mit chapter_id zieht an den Abschnitt.
//   * Kapitel mit mehreren Abschnitten bleiben Kapitel-Anker.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
let sessionUser;

const ME = 'autor@test.dev';
const OTHER = 'eindringling@test.dev';
const MY_BOOK = 9301;
const FOREIGN_BOOK = 9302;
const MY_CHAPTER = 9311;   // genau ein Abschnitt → Einabschnitts-Kapitel
const MULTI_CHAPTER = 9312; // zwei Abschnitte
const SOLE_PAGE = 9321;
const NOW = '2026-01-01T00:00:00.000Z';

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => {
      req.session = sessionUser ? { user: { email: sessionUser } } : {};
      next();
    });
    app.use('/ideen', require('../../routes/ideen'));
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

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
  await startServer();
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

test.beforeEach(() => {
  sessionUser = ME;
  const { grantAccess } = require('../../db/book-access');
  for (const t of ['idea_links', 'ideen', 'book_settings', 'book_access']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  ctx.dbSeed._wipeDb?.();
  db.prepare('DELETE FROM pages').run();
  db.prepare('DELETE FROM chapters').run();
  db.prepare('DELETE FROM books').run();
  const insBook = db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
  insBook.run(MY_BOOK, 'Mein Buch', NOW, NOW);
  insBook.run(FOREIGN_BOOK, 'Fremdes Buch', NOW, NOW);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, 0, ?)')
    .run(MY_CHAPTER, MY_BOOK, 'Kapitel', NOW);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, 1, ?)')
    .run(MULTI_CHAPTER, MY_BOOK, 'Zwei Abschnitte', NOW);
  const insPage = db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, updated_at) VALUES (?, ?, ?, ?, ?)');
  insPage.run(SOLE_PAGE, MY_BOOK, MY_CHAPTER, 'Einziger', NOW);
  insPage.run(9322, MY_BOOK, MULTI_CHAPTER, 'A', NOW);
  insPage.run(9323, MY_BOOK, MULTI_CHAPTER, 'B', NOW);
  grantAccess(MY_BOOK, ME, 'editor', ME);
  grantAccess(FOREIGN_BOOK, OTHER, 'owner', OTHER);
});

test('POST: Kapitel-Anker eines Einabschnitts-Kapitels wird zum Abschnitt', async () => {
  const r = await api('POST', '/ideen', { book_id: MY_BOOK, chapter_id: MY_CHAPTER, content: 'Plan' });
  assert.equal(r.status, 200);
  assert.equal(r.json.page_id, SOLE_PAGE);
  assert.equal(r.json.chapter_id, null);
});

test('POST: Kapitel mit mehreren Abschnitten bleibt Kapitel-Anker', async () => {
  const r = await api('POST', '/ideen', { book_id: MY_BOOK, chapter_id: MULTI_CHAPTER, content: 'Plan' });
  assert.equal(r.status, 200);
  assert.equal(r.json.chapter_id, MULTI_CHAPTER);
  assert.equal(r.json.page_id, null);
});

test('PATCH: Umzug an ein Einabschnitts-Kapitel landet am Abschnitt', async () => {
  const made = await api('POST', '/ideen', { book_id: MY_BOOK, chapter_id: MULTI_CHAPTER, content: 'Wandert' });
  const r = await api('PATCH', `/ideen/${made.json.id}`, { chapter_id: MY_CHAPTER });
  assert.equal(r.status, 200);
  assert.equal(r.json.page_id, SOLE_PAGE);
  assert.equal(r.json.chapter_id, null);
});
