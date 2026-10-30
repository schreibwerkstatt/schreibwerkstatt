'use strict';
// Integration: Plot-Chat-Routen.
//  - POST /chat/session/plot + GET /chat/sessions/plot/:book_id (editor+)
//  - POST /jobs/plot-chat: Lektor → 403, Session anderer Art → 404 (beides vor
//    dem Speichern der Frage). Der Erfolgsfall startet einen echten KI-Job und
//    wird hier bewusst nicht gefahren (Job beider Pfade mit gemocktem Provider:
//    tests/unit/plot-chat-job.test.js).
//  - PATCH /plot/chat-proposal: Status übernommen/verworfen/wieder offen,
//    Besitz über die Session, nur kind='plot'.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const OWNER = 'autor@test.dev';
const LEKTOR = 'lektor@test.dev';
const OTHER = 'fremd@test.dev';
const BOOK = 9511;
const NOW = '2026-01-01T00:00:00.000Z';

let ctx; let db; let server; let baseUrl; let appSettings;
let plotSessionId; let researchSessionId; let msgId; let researchMsgId;

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  appSettings = require('../../lib/app-settings');
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Testbuch', ?, ?)").run(BOOK, NOW, NOW);
  const appUsers = require('../../db/app-users');
  for (const email of [OWNER, LEKTOR, OTHER]) {
    if (!db.prepare('SELECT 1 FROM app_users WHERE email = ?').get(email)) appUsers.createUser({ email, displayName: email });
  }
  const access = require('../../db/book-access');
  access.grantAccess(BOOK, OWNER, 'editor', OWNER);
  access.grantAccess(BOOK, LEKTOR, 'lektor', OWNER);
  access.grantAccess(BOOK, OTHER, 'editor', OWNER);
  const mkSession = (kind) => db.prepare(
    'INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at) VALUES (?, ?, ?, ?, ?)'
  ).run(BOOK, kind, OWNER, NOW, NOW).lastInsertRowid;
  plotSessionId = mkSession('plot');
  researchSessionId = mkSession('research');
  const proposals = [
    { type: 'beat_create', ref: 1, act_id: 1, thread_id: null, fields: { titel: 'A' } },
    { type: 'act_create', ref: 2, name: 'B', thread_id: null },
  ];
  const mkMsg = (sid) => db.prepare(
    "INSERT INTO chat_messages (session_id, role, content, context_info, created_at) VALUES (?, 'assistant', 'x', ?, ?)"
  ).run(sid, JSON.stringify({ mode: 'plot', proposals }), NOW).lastInsertRowid;
  msgId = mkMsg(plotSessionId);
  researchMsgId = mkMsg(researchSessionId);

  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.get('x-user') || OWNER } }; next(); });
  app.use('/jobs', require('../../routes/jobs/chat').chatRouter);
  app.use('/chat', require('../../routes/chat'));
  app.use('/plot', require('../../routes/plot'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

async function call(method, path, body, user = OWNER) {
  const r = await fetch(`${baseUrl}${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'x-user': user },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const userMsgCount = (sid) => db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ? AND role = 'user'").get(sid).n;
const proposalsOf = (id) => JSON.parse(db.prepare('SELECT context_info FROM chat_messages WHERE id = ?').get(id).context_info).proposals;

test('Session anlegen + auflisten (kind=plot), Lektor darf nicht', async () => {
  const created = await call('POST', '/chat/session/plot', { book_id: BOOK });
  assert.equal(created.status, 200);
  assert.equal(db.prepare('SELECT kind FROM chat_sessions WHERE id = ?').get(created.json.id).kind, 'plot');
  const list = await call('GET', `/chat/sessions/plot/${BOOK}`);
  assert.equal(list.status, 200);
  assert.ok(list.json.some(s => s.id === plotSessionId), 'Session mit Nachrichten erscheint');
  assert.ok(!list.json.some(s => s.id === researchSessionId), 'keine Session anderer Art');
  const denied = await call('POST', '/chat/session/plot', { book_id: BOOK }, LEKTOR);
  assert.equal(denied.status, 403);
});

test('POST /jobs/plot-chat: Lektor → 403, keine verwaiste Frage', async () => {
  const sid = db.prepare(
    "INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at) VALUES (?, 'plot', ?, ?, ?)"
  ).run(BOOK, LEKTOR, NOW, NOW).lastInsertRowid;
  const r = await call('POST', '/jobs/plot-chat', { session_id: sid, message: 'Drei Beats für Akt 2?' }, LEKTOR);
  assert.equal(r.status, 403);
  assert.equal(userMsgCount(sid), 0);
});

test('POST /jobs/plot-chat: Session anderer Art → 404', async () => {
  const r = await call('POST', '/jobs/plot-chat', { session_id: researchSessionId, message: 'x' });
  assert.equal(r.status, 404);
  assert.equal(userMsgCount(researchSessionId), 0);
});

test('PATCH /plot/chat-proposal: übernommen → applied_at + applied_id', async () => {
  const r = await call('PATCH', '/plot/chat-proposal', { message_id: msgId, index: 0, action: 'applied', applied_id: 42 });
  assert.equal(r.status, 200);
  assert.equal(r.json.proposal.applied_id, 42);
  const p = proposalsOf(msgId)[0];
  assert.ok(p.applied_at);
  assert.equal(p.applied_id, 42);
  assert.equal(p.fields.titel, 'A', 'Vorschlags-Inhalt bleibt erhalten');
  // Verwerfen eines übernommenen Vorschlags → 409
  const d = await call('PATCH', '/plot/chat-proposal', { message_id: msgId, index: 0, action: 'discarded' });
  assert.equal(d.status, 409);
  assert.equal(d.json.error_code, 'PROPOSAL_ALREADY_APPLIED');
});

test('PATCH /plot/chat-proposal: verwerfen + wieder öffnen, anderer Index unberührt', async () => {
  assert.equal((await call('PATCH', '/plot/chat-proposal', { message_id: msgId, index: 1, action: 'discarded' })).status, 200);
  assert.equal(proposalsOf(msgId)[1].status, 'discarded');
  assert.ok(proposalsOf(msgId)[0].applied_at, 'Index 0 bleibt übernommen');
  assert.equal((await call('PATCH', '/plot/chat-proposal', { message_id: msgId, index: 1, action: 'reopen' })).status, 200);
  assert.equal(proposalsOf(msgId)[1].status, undefined);
});

test('PATCH /plot/chat-proposal: fremde Session, Recherche-Nachricht, Unsinn → 404/400', async () => {
  assert.equal((await call('PATCH', '/plot/chat-proposal', { message_id: msgId, index: 1, action: 'discarded' }, OTHER)).status, 404);
  assert.equal((await call('PATCH', '/plot/chat-proposal', { message_id: researchMsgId, index: 0, action: 'applied' })).status, 404);
  assert.equal((await call('PATCH', '/plot/chat-proposal', { message_id: msgId, index: 9, action: 'applied' })).status, 404);
  assert.equal((await call('PATCH', '/plot/chat-proposal', { message_id: msgId, index: 0, action: 'kaputt' })).status, 400);
  assert.equal((await call('PATCH', '/plot/chat-proposal', { message_id: msgId, index: -1, action: 'applied' })).status, 400);
});

test('PATCH /plot/chat-proposal: zweites «applied» → 409; nach Undo des Angelegten erneut übernehmbar', async () => {
  const plot = require('../../db/plot');
  const act = plot.createAct(BOOK, OWNER, { name: 'Akt' });
  const beat = plot.createBeat(BOOK, act.id, OWNER, { titel: 'Angelegt' });
  const m = db.prepare(
    "INSERT INTO chat_messages (session_id, role, content, context_info, created_at) VALUES (?, 'assistant', 'x', ?, ?)"
  ).run(plotSessionId, JSON.stringify({ mode: 'plot', proposals: [
    { type: 'beat_create', ref: 1, act_id: act.id, thread_id: null, fields: { titel: 'Angelegt' } },
    { type: 'act_update', ref: 2, act_id: act.id, name: 'Neu', before: { name: 'Akt' } },
  ] }), NOW).lastInsertRowid;
  assert.equal((await call('PATCH', '/plot/chat-proposal', { message_id: m, index: 0, action: 'applied', applied_id: beat.id })).status, 200);
  const again = await call('PATCH', '/plot/chat-proposal', { message_id: m, index: 0, action: 'applied', applied_id: beat.id + 1 });
  assert.equal(again.status, 409);
  assert.equal(again.json.error_code, 'PROPOSAL_ALREADY_APPLIED');
  assert.equal(again.json.proposal.applied_id, beat.id);
  plot.deleteBeat(beat.id);
  const re = await call('PATCH', '/plot/chat-proposal', { message_id: m, index: 0, action: 'applied', applied_id: 555 });
  assert.equal(re.status, 200);
  assert.equal(proposalsOf(m)[0].applied_id, 555);
  assert.equal((await call('PATCH', '/plot/chat-proposal', { message_id: m, index: 1, action: 'applied', applied_id: act.id })).status, 200);
  assert.equal((await call('PATCH', '/plot/chat-proposal', { message_id: m, index: 1, action: 'applied', applied_id: act.id })).status, 409);
});
