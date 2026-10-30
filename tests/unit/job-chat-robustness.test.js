'use strict';
// Robustheit rund um Job-Lifecycle und Chats:
//   • lib/job-log-buffer: Log-Zeilen eines beendeten Jobs (Fire-and-forget-
//     Nachlauf nach completeJob mit geerbtem ALS-Context) legen keinen neuen
//     Puffer an — sonst wächst die Map unbegrenzt.
//   • aiCall räumt seinen `tok.inflight`-Eintrag auch, wenn der Call wirft.
//   • Klassische Chats: Ablehnung (stop_reason refusal) → Hinweis-Marker, leere
//     Antwort → Leer-Marker, nie eine leere Assistant-Nachricht.
//   • Bewertungs-Pflichtfelder (shared/review-validate.js) für Buch- und Kapitelbewertung.
//   • Session-Titel: abbrechbar/zeitbegrenzt und im Kosten-Ledger gebucht.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('job-chat-robustness');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
require('../../db/migrations');

const aiPath = require.resolve('../../lib/ai');
const realAi = require(aiPath);
let mockCall = null;
require.cache[aiPath].exports = {
  ...realAi,
  callAI: (...args) => mockCall(...args),
};

const shared = require('../../routes/jobs/shared');
const jobLogBuffer = require('../../lib/job-log-buffer');
const logger = require('../../logger');
const { runWithContext } = require('../../lib/log-context');
const { _parseChatResponse } = require('../../routes/jobs/chat/shared');
const { EMPTY_ANSWER_MARKER, REFUSAL_MARKER } = require('../../routes/jobs/agentic-chat');
const { normalizeGesamtnote, assertChapterAnalysis, sortEmpfehlungen } = require('../../routes/jobs/shared/review-validate');
const { db } = require('../../db/connection');

db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run('u@x');

// ── job-log-buffer ───────────────────────────────────────────────────────────
test('job-log-buffer: append ohne open wird verworfen', () => {
  const before = jobLogBuffer.size();
  jobLogBuffer.append('nie-geoeffnet', 'zeile');
  assert.equal(jobLogBuffer.size(), before);
  assert.equal(jobLogBuffer.snapshot('nie-geoeffnet'), '');
});

test('job-log-buffer: Log nach completeJob (geerbter jobId-Context) legt keinen Puffer an', async () => {
  const id = shared.createJob('test-logbuf', 'b1', 'u@x', null);
  shared.jobs.get(id).status = 'running';
  await runWithContext({ jobId: id }, async () => { logger.info('waehrend des Jobs'); });
  assert.match(jobLogBuffer.snapshot(id), /waehrend des Jobs/);
  shared.completeJob(id, {});
  const size = jobLogBuffer.size();
  await runWithContext({ jobId: id }, async () => { logger.info('Nachlauf nach completeJob'); });
  assert.equal(jobLogBuffer.size(), size);
  assert.equal(jobLogBuffer.snapshot(id), '');
});

test('job-log-buffer: Zahl offener Puffer ist gedeckelt', () => {
  for (let i = 0; i < jobLogBuffer.MAX_OPEN + 20; i++) jobLogBuffer.open(`cap-${i}`);
  assert.ok(jobLogBuffer.size() <= jobLogBuffer.MAX_OPEN);
  for (let i = 0; i < jobLogBuffer.MAX_OPEN + 20; i++) jobLogBuffer.clear(`cap-${i}`);
});

// ── aiCall: inflight-Eintrag auch auf dem Fehlerpfad räumen ────────────────
test('aiCall: wirft der Call, bleibt kein inflight-Eintrag stehen', async () => {
  const id = shared.createJob('test-inflight', 'b1', 'u@x', null);
  shared.jobs.get(id).status = 'running';
  mockCall = async (_p, _s, onProgress) => {
    onProgress({ chars: 400, tokIn: 100 });
    throw new Error('provider kaputt');
  };
  const tok = { in: 0, out: 0, ms: 0, inflight: new Map() };
  await assert.rejects(shared.aiCall(id, tok, 'prompt', 'system'), /provider kaputt/);
  assert.equal(tok.inflight.size, 0);
});

// ── Klassische Chats: Ablehnung / leere Antwort ──────────────────────────────
test('_parseChatResponse: refusal → Hinweis-Marker, Teil-Output und Vorschläge verfallen', () => {
  const r = _parseChatResponse('{"antwort":"Teil', { stopReason: 'refusal', stopDetails: { category: 'cyber' } }, { warn() {} });
  assert.equal(r.antwort, REFUSAL_MARKER);
  assert.deepEqual(r.vorschlaege, []);
  assert.equal(r.refused, true);
});

test('_parseChatResponse: leerer Text → Leer-Marker statt leerer Nachricht', () => {
  assert.equal(_parseChatResponse('').antwort, EMPTY_ANSWER_MARKER);
  assert.equal(_parseChatResponse('{"antwort":"   "}').antwort, EMPTY_ANSWER_MARKER);
  assert.equal(_parseChatResponse('{"antwort":"Hallo"}').antwort, 'Hallo');
});

// ── Bewertungs-Pflichtfelder ─────────────────────────────────────────────────
test('normalizeGesamtnote: Zahl-String → Zahl, ausserhalb 1–6 / fehlend wirft', () => {
  assert.equal(normalizeGesamtnote({ gesamtnote: '4.5' }).gesamtnote, 4.5);
  assert.throws(() => normalizeGesamtnote({}), /gesamtnoteMissing/);
  assert.throws(() => normalizeGesamtnote({ gesamtnote: 7 }), /gesamtnoteInvalid/);
  assert.throws(() => normalizeGesamtnote({ gesamtnote: 'gut' }), /gesamtnoteInvalid/);
});

test('assertChapterAnalysis: leere Teil-Analyse wirft mit Namen', () => {
  assert.doesNotThrow(() => assertChapterAnalysis({ themen: 'Verlust' }, 'K1'));
  assert.throws(() => assertChapterAnalysis({ themen: ' ', funktion_kurz: '' }, 'K1 (2/3)'),
    (e) => e.message === 'job.error.chapterAnalysisEmpty' && e.i18nParams.name === 'K1 (2/3)');
});

test('sortEmpfehlungen: hoch → mittel → niedrig, stabil; Alt-Strings bleiben stehen', () => {
  const r = sortEmpfehlungen({ empfehlungen: [
    { prio: 'niedrig', text: 'a' }, { prio: 'hoch', text: 'b' }, { prio: 'mittel', text: 'c' },
    { prio: 'Hoch', text: 'd' }, { text: 'e' },
  ] });
  assert.deepEqual(r.empfehlungen.map(e => e.text), ['b', 'd', 'c', 'a', 'e']);
  assert.deepEqual(sortEmpfehlungen({ empfehlungen: ['x', 'y'] }).empfehlungen, ['x', 'y']);
  assert.deepEqual(sortEmpfehlungen({}), {});
});

// ── Session-Titel ────────────────────────────────────────────────────────────
test('generateSessionTitle: Call bekommt ein Signal und wird im Ledger gebucht', async () => {
  const { generateSessionTitle } = require('../../routes/jobs/chat-title');
  db.prepare(`INSERT OR IGNORE INTO books (book_id, name, created_at, updated_at) VALUES (77, 'T', '2026-01-01', '2026-01-01')`).run();
  const sid = db.prepare(`INSERT INTO chat_sessions (book_id, user_email, kind, created_at, last_message_at)
    VALUES (77, 'u@x', 'research', '2026-01-01', '2026-01-01')`).run().lastInsertRowid;
  let seenSignal = null;
  mockCall = async (_p, _s, _o, _m, signal) => {
    seenSignal = signal;
    return { text: '{"titel":"Ein Titel"}', truncated: false, tokensIn: 300, tokensOut: 12, provider: 'claude', model: 'claude-sonnet-4-5' };
  };
  const session = { id: sid, title: null, user_email: 'u@x', kind: 'research', book_id: 77 };
  const titel = await generateSessionTitle({ session, userMessage: 'Frage', assistantAnswer: 'Antwort', provider: 'claude' });
  assert.equal(titel, 'Ein Titel');
  assert.ok(seenSignal instanceof AbortSignal, 'Titel-Call muss abbrechbar/zeitbegrenzt sein');
  const row = db.prepare('SELECT tokens_in, tokens_out, source FROM ai_cost_ledger WHERE source_ref = ?').get(`chatjob:title:${sid}`);
  assert.ok(row, 'Ledger-Zeile fehlt');
  assert.equal(row.tokens_in, 300);
  assert.equal(row.source, 'chat');
});

test('generateSessionTitle: spätere Runde titelt aus der ERSTEN Frage der Session', async () => {
  const { generateSessionTitle } = require('../../routes/jobs/chat-title');
  db.prepare(`INSERT OR IGNORE INTO books (book_id, name, created_at, updated_at) VALUES (77, 'T', '2026-01-01', '2026-01-01')`).run();
  const sid = db.prepare(`INSERT INTO chat_sessions (book_id, user_email, kind, created_at, last_message_at)
    VALUES (77, 'u@x', 'book', '2026-01-01', '2026-01-01')`).run().lastInsertRowid;
  const ins = db.prepare(`INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)`);
  ins.run(sid, 'user', 'Wie alt ist Anna?', '2026-01-01T10:00:00.000Z');
  ins.run(sid, 'assistant', 'Anna ist 34.', '2026-01-01T10:00:05.000Z');
  ins.run(sid, 'user', 'Und ihr Bruder?', '2026-01-01T10:01:00.000Z');
  ins.run(sid, 'assistant', 'Tom ist 30.', '2026-01-01T10:01:05.000Z');
  let seenConvo = null;
  mockCall = async (convo) => {
    seenConvo = convo;
    return { text: '{"titel":"Annas Alter"}', truncated: false, tokensIn: 10, tokensOut: 3, provider: 'claude', model: 'm' };
  };
  const session = { id: sid, title: null, user_email: 'u@x', kind: 'book', book_id: 77 };
  await generateSessionTitle({ session, userMessage: 'Und ihr Bruder?', assistantAnswer: 'Tom ist 30.', provider: 'claude' });
  assert.match(seenConvo, /Wie alt ist Anna\?/);
  assert.match(seenConvo, /Anna ist 34/);
  assert.doesNotMatch(seenConvo, /Bruder|Tom/);
});
