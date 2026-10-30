'use strict';
// Integration: POST /jobs/book-chat `mode` («Nochmals mit ganzem Buch»).
//   - `mode: 'full'` landet als context_info.book_chat_mode an der Frage; der Job
//     liest es von dort (_requestedMode).
//   - ein unbekannter Modus ist ein 400, bevor die Nachricht gespeichert wird.
// Der Job selbst ist hier gestubbt (require.cache) — geprüft wird der Weg bis zum
// Job, nicht der KI-Call.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const OWNER = 'bcmode-owner@test.dev';
const BOOK = 9621;
const NOW = '2026-01-01T00:00:00.000Z';

let ctx; let db; let server; let baseUrl; let sid;
const runs = [];

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  // Job-Stub VOR dem Router laden: der Router destrukturiert beim require.
  const real = require('../../routes/jobs/chat/book-chat');
  const modPath = path.resolve(__dirname, '../../routes/jobs/chat/book-chat.js');
  require.cache[modPath].exports = {
    ...real,
    runBookChatJobDispatch: (jobId, sessionId, userMsgId) => { runs.push({ jobId, sessionId, userMsgId }); },
  };
  delete require.cache[require.resolve('../../routes/jobs/chat')];
  const { chatRouter } = require('../../routes/jobs/chat');

  const appUsers = require('../../db/app-users');
  if (!appUsers.getUser(OWNER)) appUsers.createUser({ email: OWNER });
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Modusbuch', ?, ?)").run(BOOK, NOW, NOW);
  require('../../db/book-access').grantAccess(BOOK, OWNER, 'editor', OWNER);
  sid = db.prepare(
    "INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at) VALUES (?, 'book', ?, ?, ?)",
  ).run(BOOK, OWNER, NOW, NOW).lastInsertRowid;

  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: OWNER } }; next(); });
  app.use('/jobs', chatRouter);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

const post = (body) => fetch(`${baseUrl}/jobs/book-chat`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const msgCount = () => db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?').get(sid).n;

test('unbekannter Modus → 400, keine Nachricht gespeichert', async () => {
  const before = msgCount();
  const r = await post({ session_id: sid, message: 'Wer ist Anna?', mode: 'turbo' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error_code, 'BOOK_CHAT_MODE_INVALID');
  assert.equal(msgCount(), before);
});

test("mode 'full' steht an der Frage und erreicht den Job", async () => {
  const r = await post({ session_id: sid, message: 'Wer ist Anna?', mode: 'full' });
  assert.equal(r.status, 200);
  await new Promise((res) => setImmediate(res));
  const run = runs.at(-1);
  assert.ok(run, 'Job wurde gestartet');
  const row = db.prepare('SELECT context_info FROM chat_messages WHERE id = ?').get(run.userMsgId);
  assert.deepEqual(JSON.parse(row.context_info), { book_chat_mode: 'full' });
  const { _requestedMode } = require('../../routes/jobs/chat/book-chat');
  assert.equal(_requestedMode(run.userMsgId), 'full');
});

test('ohne Modus: keine context_info, normaler Lauf', async () => {
  // Der gestubbte Job der vorigen Frage endet nie — eigene Session, sonst 409.
  const sid2 = db.prepare(
    "INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at) VALUES (?, 'book', ?, ?, ?)",
  ).run(BOOK, OWNER, NOW, NOW).lastInsertRowid;
  const r = await post({ session_id: sid2, message: 'Und Tom?' });
  assert.equal(r.status, 200);
  await new Promise((res) => setImmediate(res));
  const run = runs.at(-1);
  const row = db.prepare('SELECT context_info FROM chat_messages WHERE id = ?').get(run.userMsgId);
  assert.equal(row.context_info, null);
  const { _requestedMode } = require('../../routes/jobs/chat/book-chat');
  assert.equal(_requestedMode(run.userMsgId), null);
});
