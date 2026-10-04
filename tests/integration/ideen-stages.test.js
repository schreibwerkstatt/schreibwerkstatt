'use strict';
// Ideen-Stufen pro Buch (book_settings.ideen_stages, docs/ideen-board.md).
//
// Drei Aussagen, alle am echten Router:
//   * `offen` und `erledigt` lassen sich nicht abschalten — der Server
//     normalisiert, was immer der Client schickt.
//   * In eine abgeschaltete Stufe wird nicht gewechselt (IDEE_STATUS_INACTIVE).
//   * Eine Idee, die schon in einer abgeschalteten Stufe steht, sitzt nicht
//     fest: herauswechseln geht, und das Board liefert sie weiter aus.

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
const MY_BOOK = 9201;
const FOREIGN_BOOK = 9202;
const MY_CHAPTER = 9211;
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
  grantAccess(MY_BOOK, ME, 'editor', ME);
  grantAccess(FOREIGN_BOOK, OTHER, 'owner', OTHER);
});

async function newIdee() {
  const r = await api('POST', '/ideen', { book_id: MY_BOOK, chapter_id: MY_CHAPTER, content: 'Pendenz' });
  assert.equal(r.status, 200);
  return r.json.id;
}

test('Stufen: ohne Einstellung alle vier, im Board und in /stages', async () => {
  const s = await api('GET', `/ideen/stages?book_id=${MY_BOOK}`);
  assert.equal(s.status, 200);
  assert.deepEqual(s.json.stages, ['offen', 'in_arbeit', 'erledigt', 'verworfen']);
  const b = await api('GET', `/ideen/board?book_id=${MY_BOOK}`);
  assert.deepEqual(b.json.stages, ['offen', 'in_arbeit', 'erledigt', 'verworfen']);
});

test('Stufen: offen + erledigt sind fest, Unbekanntes faellt weg, Reihenfolge kanonisch', async () => {
  const r = await api('PUT', '/ideen/stages', { book_id: MY_BOOK, stages: ['verworfen', 'quatsch'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.stages, ['offen', 'erledigt', 'verworfen']);

  const empty = await api('PUT', '/ideen/stages', { book_id: MY_BOOK, stages: [] });
  assert.deepEqual(empty.json.stages, ['offen', 'erledigt']);
  assert.deepEqual((await api('GET', `/ideen/stages?book_id=${MY_BOOK}`)).json.stages, ['offen', 'erledigt']);
});

test('Stufen: fremdes Buch → 403, ohne Liste → 400', async () => {
  assert.equal((await api('PUT', '/ideen/stages', { book_id: FOREIGN_BOOK, stages: [] })).status, 403);
  assert.equal((await api('GET', `/ideen/stages?book_id=${FOREIGN_BOOK}`)).status, 403);
  assert.equal((await api('PUT', '/ideen/stages', { book_id: MY_BOOK })).status, 400);
});

test('Stufen: Wechsel in eine abgeschaltete Stufe → 400 IDEE_STATUS_INACTIVE', async () => {
  const id = await newIdee();
  await api('PUT', '/ideen/stages', { book_id: MY_BOOK, stages: [] });
  const r = await api('PATCH', `/ideen/${id}`, { status: 'in_arbeit' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'IDEE_STATUS_INACTIVE');
  const ok = await api('PATCH', `/ideen/${id}`, { status: 'erledigt' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, 'erledigt');
});

test('Stufen: wer schon in der abgeschalteten Stufe steht, bleibt sichtbar und kommt heraus', async () => {
  const id = await newIdee();
  assert.equal((await api('PATCH', `/ideen/${id}`, { status: 'in_arbeit' })).status, 200);
  await api('PUT', '/ideen/stages', { book_id: MY_BOOK, stages: [] });

  const board = await api('GET', `/ideen/board?book_id=${MY_BOOK}`);
  assert.equal(board.json.ideen.find(i => i.id === id)?.status, 'in_arbeit');

  // Gleicher Status ist kein Wechsel — z.B. ein Content-PATCH, der ihn mitschickt.
  assert.equal((await api('PATCH', `/ideen/${id}`, { status: 'in_arbeit', content: 'neu' })).status, 200);
  const out = await api('PATCH', `/ideen/${id}`, { status: 'offen' });
  assert.equal(out.status, 200);
  assert.equal(out.json.status, 'offen');
});
