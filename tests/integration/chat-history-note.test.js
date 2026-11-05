'use strict';
// Integration: GET /chat/session/:id — eine Assistant-Antwort ohne Echo des
// Verlaufs-Anhangs.
//
// Der Buch-Chat zeigt die Belege als Liste unter der Antwort (context_info.citations),
// der Abschnitts-Chat die Vorschlaege (Spalte vorschlaege). Eine aeltere Antwort kann
// im Text ein Echo des maschinellen Verlaufs-Anhangs tragen (das Modell hat den
// Anhang als eigenen Text gelesen und ihn mitgeschrieben) — beim Lesen wird es
// entfernt (lib/chat-history-note.js). Eine User-Nachricht bleibt unangetastet.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const OWNER = 'cite-owner@test.dev';
const BOOK = 9711;
const NOW = '2026-01-01T00:00:00.000Z';
const ECHO = '[Belege dieser Antwort: (1) Abschnitt «Kap 1» (page_id 7): «Stefan war achtundzwanzig.»]';

let ctx; let db; let server; let baseUrl; let sessionId; let pageSessionId;

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  const bookAccess = require('../../db/book-access');
  const appUsers = require('../../db/app-users');
  if (!appUsers.getUser(OWNER)) appUsers.createUser({ email: OWNER });
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Citebuch', ?, ?)").run(BOOK, NOW, NOW);
  bookAccess.grantAccess(BOOK, OWNER, 'editor', OWNER);
  sessionId = db.prepare(
    "INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at) VALUES (?, 'book', ?, ?, ?)"
  ).run(BOOK, OWNER, NOW, NOW).lastInsertRowid;
  const ins = db.prepare('INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)');
  ins.run(sessionId, 'user', 'Frage mit [Belege] im Text?', NOW);
  ins.run(sessionId, 'assistant', `Antwort.\n\n${ECHO}`, NOW);

  // Abschnitts-Chat: Echo des Vorschlags-Anhangs in der Antwort.
  const pageId = db.prepare("INSERT INTO pages (book_id, page_name, body_html, updated_at) VALUES (?, 'Seite 1', '<p>Hund</p>', ?)").run(BOOK, NOW).lastInsertRowid;
  pageSessionId = db.prepare(
    "INSERT INTO chat_sessions (book_id, page_id, kind, user_email, created_at, last_message_at) VALUES (?, ?, 'page', ?, ?, ?)"
  ).run(BOOK, pageId, OWNER, NOW, NOW).lastInsertRowid;
  ins.run(pageSessionId, 'user', 'Wie klingt der Hund?', NOW);
  ins.run(pageSessionId, 'assistant', 'Der Hund bellt laut.\n\n[Deine Änderungsvorschläge in dieser Antwort, Status beim Autor:\n1. [offen] «Der Hund bellt laut.» → «Der Hund bellt leise.»\n]', NOW);

  const chatRouter = require('../../routes/chat');
  const app = express();
  // Test-Login: E-Mail aus dem Header.
  app.use((req, _res, next) => { req.session = { user: { email: req.headers['x-test-user'] } }; next(); });
  app.use('/chat', chatRouter);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

test('GET /chat/session/:id (Abschnitts-Chat): Assistant-Antwort ohne Vorschlags-Echo', async () => {
  const r = await fetch(`${baseUrl}/chat/session/${pageSessionId}`, { headers: { 'x-test-user': OWNER } });
  assert.equal(r.status, 200);
  const data = await r.json();
  const answer = data.messages.find(m => m.role === 'assistant');
  assert.equal(answer.content, 'Der Hund bellt laut.');
});

test('GET /chat/session/:id: Assistant-Antwort ohne Beleg-Echo, User-Nachricht unveraendert', async () => {
  const r = await fetch(`${baseUrl}/chat/session/${sessionId}`, { headers: { 'x-test-user': OWNER } });
  assert.equal(r.status, 200);
  const data = await r.json();
  const user = data.messages.find(m => m.role === 'user');
  const answer = data.messages.find(m => m.role === 'assistant');
  assert.equal(user.content, 'Frage mit [Belege] im Text?', 'User-Nachricht bleibt unangetastet');
  assert.equal(answer.content, 'Antwort.');
  assert.doesNotMatch(answer.content, /Belege dieser Antwort/);
});
