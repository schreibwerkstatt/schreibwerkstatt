'use strict';
// Integration: GET /chat/search/:book_id (Suche im Verlauf, docs/chats.md#suche-im-verlauf).
// Buch-ACL über aclParamGuard (kein Zugriff → 403), Pflicht-Parameter (→ 400),
// Treffer nur aus den EIGENEN Gesprächen — auch wenn ein Mitautor im selben Buch
// über dasselbe Thema gechattet hat. Ohne Embedding-Endpunkt: nur Wortlaut.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const OWNER = 'cs-owner@test.dev';
const COAUTHOR = 'cs-co@test.dev';
const STRANGER = 'cs-stranger@test.dev';
const BOOK = 9521;
const NOW = '2026-01-01T00:00:00.000Z';

let ctx; let db; let server; let baseUrl;
let ownSession;

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  const bookAccess = require('../../db/book-access');
  const appUsers = require('../../db/app-users');
  for (const email of [OWNER, COAUTHOR, STRANGER]) {
    if (!appUsers.getUser(email)) appUsers.createUser({ email });
  }
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Suchbuch', ?, ?)").run(BOOK, NOW, NOW);
  bookAccess.grantAccess(BOOK, OWNER, 'editor', OWNER);
  bookAccess.grantAccess(BOOK, COAUTHOR, 'editor', OWNER);
  const ses = db.prepare("INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at) VALUES (?, 'book', ?, ?, ?)");
  const ins = db.prepare('INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)');
  ownSession = ses.run(BOOK, OWNER, NOW, NOW).lastInsertRowid;
  ins.run(ownSession, 'user', 'Wann stirbt der Leuchtturmwärter?', NOW);
  ins.run(ownSession, 'assistant', 'Im vorletzten Kapitel.', NOW);
  const coSession = ses.run(BOOK, COAUTHOR, NOW, NOW).lastInsertRowid;
  ins.run(coSession, 'user', 'Leuchtturmwärter — Motiv?', NOW);
  ins.run(coSession, 'assistant', 'Einsamkeit.', NOW);

  const chatRouter = require('../../routes/chat');
  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.headers['x-test-user'] } }; next(); });
  app.use('/chat', chatRouter);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

async function search(qs, user = OWNER) {
  const r = await fetch(`${baseUrl}/chat/search/${BOOK}?${qs}`, { headers: { 'x-test-user': user } });
  return { status: r.status, json: await r.json().catch(() => null) };
}

test('Eigene Gespräche, Präfix-Wortlaut, ohne Embedding-Endpunkt', async () => {
  const r = await search('q=Leuchtturm&kind=book');
  assert.equal(r.status, 200);
  assert.equal(r.json.semantic, false);
  assert.equal(r.json.indexing, false);
  assert.deepEqual(r.json.hits.map(h => h.session_id), [ownSession]);
  assert.match(r.json.hits[0].snippet, /<mark>Leuchtturmwärter<\/mark>/);
});

test('Mitautor sieht nur seine eigene Session', async () => {
  const r = await search('q=Leuchtturm&kind=book', COAUTHOR);
  assert.equal(r.status, 200);
  assert.equal(r.json.hits.length, 1);
  assert.notEqual(r.json.hits[0].session_id, ownSession);
});

test('Ohne Buchzugriff → 403, ohne q/kind → 400', async () => {
  assert.equal((await search('q=Leuchtturm&kind=book', STRANGER)).status, 403);
  assert.equal((await search('kind=book')).status, 400);
  assert.equal((await search('q=Leuchtturm&kind=plot')).status, 400);
});
