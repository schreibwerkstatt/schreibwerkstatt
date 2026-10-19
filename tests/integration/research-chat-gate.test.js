'use strict';
// Integration: POST /jobs/research-chat prüft Kill-Switch + Suchweg VOR dem
// Speichern der User-Nachricht (preflight in _handleChatPost). Vorher wurde die
// Frage gespeichert und erst der Job scheiterte — die Session trug danach eine
// Frage ohne Antwort. Der Erfolgsfall wird hier bewusst NICHT gefahren (er
// startet einen echten KI-Job); den deckt die Gate-Logik im Unit-Test ab
// (tests/unit/research-chat-helpers.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const USER = 'autor@test.dev';
const BOOK = 9411;
const NOW = '2026-01-01T00:00:00.000Z';

let ctx; let db; let server; let baseUrl; let appSettings; let sessionId;

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  appSettings = require('../../lib/app-settings');
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Testbuch', ?, ?)").run(BOOK, NOW, NOW);
  require('../../db/book-access').grantAccess(BOOK, USER, 'editor', USER);
  sessionId = db.prepare(
    "INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at) VALUES (?, 'research', ?, ?, ?)"
  ).run(BOOK, USER, NOW, NOW).lastInsertRowid;

  const { chatRouter } = require('../../routes/jobs/chat');
  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: USER } }; next(); });
  app.use('/jobs', chatRouter);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

async function post(body) {
  const r = await fetch(`${baseUrl}/jobs/research-chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const msgCount = () => db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?').get(sessionId).n;

test('Kill-Switch aus → 403 RESEARCH_CHAT_DISABLED, keine verwaiste Nachricht', async () => {
  appSettings.set('ai.provider', 'claude');
  appSettings.set('ai.claude.api_key', 'sk-test');
  appSettings.set('research_chat.enabled', false);
  const r = await post({ session_id: sessionId, message: 'Wie hiess die Bronzezeit-Siedlung?' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error_code, 'RESEARCH_CHAT_DISABLED');
  assert.equal(msgCount(), 0);
});

test('Provider ohne Tool-Calling → 400 RESEARCH_CHAT_NO_TOOLS, keine verwaiste Nachricht', async () => {
  appSettings.set('research_chat.enabled', true);
  appSettings.set('ai.provider', 'ollama');
  const r = await post({ session_id: sessionId, message: 'Frage' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'RESEARCH_CHAT_NO_TOOLS');
  assert.equal(msgCount(), 0);
  appSettings.set('ai.provider', 'claude');
});

test('openai-compat, Websuche aus → 400 RESEARCH_CHAT_NO_WEBSEARCH, keine verwaiste Nachricht', async () => {
  try {
    appSettings.set('research_chat.enabled', true);
    appSettings.set('ai.provider', 'openai-compat');
    appSettings.set('websearch.provider', 'off');
    const r = await post({ session_id: sessionId, message: 'Frage' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error_code, 'RESEARCH_CHAT_NO_WEBSEARCH');
    assert.equal(msgCount(), 0);
  } finally {
    appSettings.set('ai.provider', 'claude');
  }
});
