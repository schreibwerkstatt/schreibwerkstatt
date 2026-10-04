'use strict';
// Finetune-Export, Autor-Chat Block 28: echte Buch-Chat-Paare gehen ins
// Training, ausser die Antwort trägt Daumen runter (`feedback = -1`).
// Unbewertete und positiv bewertete Antworten bleiben drin.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('finetune-chat-feedback');

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const { buildReviewSamples } = require('../../routes/jobs/finetune-export/samples/author-chat/reviews');

const USER = 'ft-fb@example.com';
const BOOK = 84001;
appUsers.createUser({ email: USER });
db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'FT', datetime('now'), datetime('now'))`).run(BOOK);

const sid = db.prepare(`INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at)
                        VALUES (?, 'book', ?, ?, ?)`).run(BOOK, USER, '2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.000Z').lastInsertRowid;
let t = 0;
function msg(role, content, feedback = null) {
  const at = new Date(Date.parse('2026-10-01T10:00:00.000Z') + (t++) * 1000).toISOString();
  return db.prepare(`INSERT INTO chat_messages (session_id, role, content, created_at, feedback) VALUES (?, ?, ?, ?, ?)`)
    .run(sid, role, content, at, feedback).lastInsertRowid;
}

const qUnrated = msg('user', 'Wer ist Anna eigentlich?');
msg('assistant', 'Anna ist die Erzählerin, eine Fotografin aus Basel.');
const qUp = msg('user', 'Wo spielt das zweite Kapitel?');
msg('assistant', 'Das zweite Kapitel spielt im Hafen von Marseille.', 1);
const qDown = msg('user', 'Wie endet das Buch?');
msg('assistant', 'Das Buch endet mit einer Hochzeit in Venedig, völlig erfunden.', -1);

test('Daumen-runter-Antworten fallen aus dem Export, der Rest bleibt', () => {
  const out = [];
  buildReviewSamples({
    langIsEn: false, displayName: 'FT', bookIdInt: BOOK, userEmail: USER,
    chapterQuestions: [], pickVariants: (_id, v) => v.map((_, i) => i),
    pushQA: (id, q, a) => out.push({ id, q, a }),
  });
  const chatIds = out.filter(s => s.id.startsWith('authorChat|chat|')).map(s => s.id);
  assert.deepEqual(chatIds.sort(), [
    `authorChat|chat|${sid}|${qUnrated}`,
    `authorChat|chat|${sid}|${qUp}`,
  ].sort());
  assert.ok(!chatIds.includes(`authorChat|chat|${sid}|${qDown}`));
});
