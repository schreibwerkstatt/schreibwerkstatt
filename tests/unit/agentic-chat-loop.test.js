'use strict';
// Geteilter agentischer Loop (routes/jobs/agentic-chat.js) mit gemocktem
// callAIWithTools: Reihenfolge final_answer ↔ andere Werkzeuge, Budget-Abbruch,
// pause_turn (serverseitige Web-Suche), leere Antwort, Kosten-Deckel pro Antwort,
// toolsForIter-Hook und web_search-Queries in context_info.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('agentic-loop');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const ai = require('../../lib/ai');
const { createJob, jobs } = require('../../routes/jobs/shared');
const { makeAgenticChatJob, EMPTY_ANSWER_MARKER } = require('../../routes/jobs/agentic-chat');

const USER = 'loop@example.com';
const BOOK = 81001;
appUsers.createUser({ email: USER });
db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Loop', datetime('now'), datetime('now'))`).run(BOOK);

function newSession() {
  // title gesetzt → kein KI-Titel-Call am Ende.
  const id = db.prepare(`INSERT INTO chat_sessions (book_id, kind, user_email, title, created_at, last_message_at)
                         VALUES (?, 'book', ?, 'T', datetime('now'), datetime('now'))`).run(BOOK, USER).lastInsertRowid;
  db.prepare(`INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, 'user', 'Frage?', datetime('now'))`).run(id);
  return id;
}

const FINAL = { name: 'final_answer' };
const TOOLS = [{ name: 'side_effect' }, { name: 'lookup' }, FINAL];

function res(over) {
  return {
    text: '', toolUses: [], rawContentBlocks: [], stopReason: 'end_turn',
    tokensIn: 100, tokensOut: 10, truncated: false, model: 'claude-sonnet-4-6', ...over,
  };
}
const tu = (name, input = {}, id = name + Math.random()) => ({ id, name, input });

// Mock-Sequenz: jede Runde liefert das nächste Ergebnis; Aufrufe werden protokolliert.
function mockCalls(seq) {
  const calls = [];
  ai.callAIWithTools = async (messages, system, tools) => {
    calls.push({ messages: structuredClone(messages), tools: tools.map(t => t.name) });
    const next = seq.shift();
    if (!next) throw new Error('Mock-Sequenz erschöpft');
    return typeof next === 'function' ? next(calls.length) : next;
  };
  return calls;
}

function makeJob(over = {}) {
  const executed = [];
  let captured = null;
  const run = makeAgenticChatJob({
    startLabel: 'Test', errLabel: 'Test',
    callProvider: 'claude',
    resolveProvider: () => 'claude',
    loadSession: (sid) => db.prepare(`SELECT cs.*, b.name AS book_name FROM chat_sessions cs JOIN books b ON b.book_id = cs.book_id WHERE cs.id = ?`).get(sid),
    async prepare() {
      return {
        systemPrompt: [{ text: 'sys' }], tools: TOOLS, maxToolIter: 4, tokenBudget: 1_000_000,
        forceFinalInstruction: 'FORCE', ctx: { effects: [] },
        ...(over.prep || {}),
      };
    },
    async executeTool(name, input, ctx) {
      executed.push(name);
      if (name === 'side_effect') ctx.effects.push(input.v);
      if (over.toolResult) return over.toolResult(name, input);
      return { ok: true, name };
    },
    ...(over.fallbackJob ? { fallbackJob: over.fallbackJob } : {}),
    consumeFinalAnswer: ({ finalUse }) => JSON.stringify({ antwort: finalUse.input?.antwort ?? '' }),
    parseFinal: (finalText) => {
      const o = JSON.parse(finalText);
      return o.antwort;
    },
    buildContextInfo: (args) => { captured = args; return { stop: args.stopReason, effects: args.ctx.effects, webQueries: args.webQueries }; },
    buildSummary: () => 'summary',
  });
  return { run, executed, ctx: () => captured };
}

async function runFailing(job, sessionId) {
  const jobId = createJob('book-chat', BOOK, USER, 'x');
  await job.run(jobId, sessionId, 1, 'Frage?', USER);
  const j = jobs.get(jobId);
  assert.equal(j.status, 'error', 'Job muss scheitern');
  return { jobId, job: j };
}

async function runJob(job, sessionId) {
  const jobId = createJob('book-chat', BOOK, USER, 'x');
  await job.run(jobId, sessionId, 1, 'Frage?', USER);
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', `Job nicht done: ${j.error}`);
  const msg = db.prepare(`SELECT content, context_info FROM chat_messages WHERE id = ?`).get(j.result.assistant_message_id);
  return { result: j.result, content: msg.content, ci: JSON.parse(msg.context_info) };
}

test('(a) final_answer neben anderen Werkzeugen: die anderen laufen zuerst (Seiteneffekte bleiben)', async () => {
  mockCalls([res({
    stopReason: 'tool_use',
    toolUses: [tu('final_answer', { antwort: 'fertig' }), tu('side_effect', { v: 42 })],
  })]);
  const job = makeJob();
  const out = await runJob(job, newSession());
  assert.deepEqual(job.executed, ['side_effect']);
  assert.deepEqual(out.ci.effects, [42]);
  assert.equal(out.content, 'fertig');
  assert.equal(out.ci.stop, 'final_answer');
});

test('(b) Budget-Überschreitung in derselben Runde verwirft final_answer nicht', async () => {
  mockCalls([res({
    stopReason: 'tool_use', tokensIn: 5_000_000,
    toolUses: [tu('final_answer', { antwort: 'trotzdem da' })],
  })]);
  const out = await runJob(makeJob({ prep: { tokenBudget: 1000 } }), newSession());
  assert.equal(out.content, 'trotzdem da');
});

test('(b) Budget-Überschreitung ohne final_answer → Runde nicht ausgeführt, Synthese statt Erzähltext', async () => {
  const calls = mockCalls([
    res({ stopReason: 'tool_use', tokensIn: 5_000_000, text: 'Ich schaue nach …', toolUses: [tu('lookup')] }),
    res({ stopReason: 'tool_use', toolUses: [tu('final_answer', { antwort: 'aus dem Gesammelten' })] }),
  ]);
  const job = makeJob({ prep: { tokenBudget: 1000, inputCapInstruction: 'BUDGET' } });
  const out = await runJob(job, newSession());
  assert.equal(out.content, 'aus dem Gesammelten');
  assert.equal(out.ci.stop, 'context_budget');
  assert.deepEqual(job.executed, [], 'die Runde über dem Budget wird nicht mehr ausgeführt');
  assert.deepEqual(calls[1].tools, ['final_answer']);
  assert.equal(calls[1].messages.at(-1).content, 'BUDGET');
  // Kein halber Assistant-Turn mit tool_use ohne tool_result.
  assert.equal(calls[1].messages.some(m => m.role === 'assistant' && Array.isArray(m.content)), false);
});

test('(c) pause_turn: Assistant-Inhalt anhängen und weiterlaufen, kein Abschluss', async () => {
  const paused = [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'Mauerfall Datum' } }];
  const calls = mockCalls([
    res({ stopReason: 'pause_turn', rawContentBlocks: paused, text: 'Zwischenstand' }),
    res({ stopReason: 'tool_use', toolUses: [tu('final_answer', { antwort: 'nach Pause' })] }),
  ]);
  const out = await runJob(makeJob(), newSession());
  assert.equal(out.content, 'nach Pause');
  assert.equal(calls.length, 2);
  const last = calls[1].messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.deepEqual(last.content, paused);
  // web_search-Queries landen in context_info (webQueries-Feld des Loops).
  assert.deepEqual(out.ci.webQueries, ['Mauerfall Datum']);
});

test('(d) leere antwort aus final_answer → i18n-Marker statt roher JSON-Hülle', async () => {
  mockCalls([res({ stopReason: 'tool_use', toolUses: [tu('final_answer', { antwort: '   ' })] })]);
  const out = await runJob(makeJob(), newSession());
  assert.equal(out.content, EMPTY_ANSWER_MARKER);
});

test('(d) leere Prosa-Antwort → i18n-Marker', async () => {
  mockCalls([res({ stopReason: 'end_turn', text: '' })]);
  const out = await runJob(makeJob(), newSession());
  assert.equal(out.content, EMPTY_ANSWER_MARKER);
});

test('Kosten-Deckel: kumulierte Input-Tokens erreicht → Synthese nur mit final_answer', async () => {
  const calls = mockCalls([
    res({ stopReason: 'tool_use', tokensIn: 600, toolUses: [tu('lookup')] }),
    res({ stopReason: 'tool_use', tokensIn: 600, toolUses: [tu('final_answer', { antwort: 'synthetisiert' })] }),
  ]);
  const out = await runJob(makeJob({ prep: { inputTokenCap: 500, inputCapInstruction: 'BUDGET' } }), newSession());
  assert.equal(out.content, 'synthetisiert');
  assert.equal(out.ci.stop, 'input_cap');
  assert.deepEqual(calls[1].tools, ['final_answer']);
  assert.equal(calls[1].messages.at(-1).content, 'BUDGET');
});

test('Iterationsdeckel: Synthese-Turn mit forceFinalInstruction', async () => {
  const seq = [];
  for (let i = 0; i < 2; i++) seq.push(res({ stopReason: 'tool_use', toolUses: [tu('lookup')] }));
  seq.push(res({ stopReason: 'end_turn', text: 'Prosa-Synthese' }));
  const calls = mockCalls(seq);
  const out = await runJob(makeJob({ prep: { maxToolIter: 2 } }), newSession());
  assert.equal(out.content, 'Prosa-Synthese');
  assert.equal(out.ci.stop, 'max_iter');
  assert.equal(calls[2].messages.at(-1).content, 'FORCE');
});

test('toolsForIter: Werkzeugliste pro Runde aus dem Hook, Synthese bleibt bei final_answer', async () => {
  const seen = [];
  const calls = mockCalls([
    res({ stopReason: 'tool_use', toolUses: [tu('lookup')] }),
    res({ stopReason: 'tool_use', toolUses: [tu('final_answer', { antwort: 'ok' })] }),
  ]);
  const toolsForIter = ({ iter, webSearches }) => {
    seen.push({ iter, webSearches });
    return iter === 0 ? [TOOLS[1], FINAL] : [FINAL];
  };
  await runJob(makeJob({ prep: { toolsForIter } }), newSession());
  assert.deepEqual(calls[0].tools, ['lookup', 'final_answer']);
  assert.deepEqual(calls[1].tools, ['final_answer']);
  assert.deepEqual(seen.map(s => s.iter), [0, 1]);
  assert.equal(seen[0].webSearches, 0);
});


test('Synthese-Turn: abgeschnittene Antwort ist ein Fehler, keine Antwort', async () => {
  mockCalls([
    res({ stopReason: 'tool_use', toolUses: [tu('lookup')] }),
    res({ stopReason: 'max_tokens', truncated: true, text: 'Halbe Ant' }),
  ]);
  const sid = newSession();
  const { job } = await runFailing(makeJob({ prep: { maxToolIter: 1 } }), sid);
  assert.equal(job.error, 'job.error.aiTruncated');
  const n = db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ? AND role = 'assistant'`).get(sid).n;
  assert.equal(n, 0);
});

test('Synthese-Turn: Provider-Fehler endet als Job-Fehler (i18n) und bucht die Runden ins Ledger', async () => {
  let n = 0;
  ai.callAIWithTools = async () => {
    n++;
    if (n === 1) return res({ stopReason: 'tool_use', tokensIn: 700, tokensOut: 30, toolUses: [tu('lookup')] });
    const e = new Error('Claude 529: overloaded'); e.code = 'AI_OVERLOADED'; e.status = 529; throw e;
  };
  const { jobId, job } = await runFailing(makeJob({ prep: { maxToolIter: 1 } }), newSession());
  assert.equal(job.error, 'job.error.agentSynthesisOverloaded');
  const row = db.prepare(`SELECT source, type, tokens_in, tokens_out FROM ai_cost_ledger WHERE source_ref = ?`).get(`chatjob:${jobId}`);
  assert.deepEqual({ ...row }, { source: 'chat', type: 'book', tokens_in: 700, tokens_out: 30 });
});

test('Synthese-Turn: final_answer mit kaputtem Argument-JSON → Fehler statt leerer Antwort', async () => {
  mockCalls([
    res({ stopReason: 'tool_use', toolUses: [tu('lookup')] }),
    res({ stopReason: 'tool_use', toolUses: [{ id: 'f1', name: 'final_answer', input: {}, parseError: 'Unexpected end' }] }),
  ]);
  const { job } = await runFailing(makeJob({ prep: { maxToolIter: 1 } }), newSession());
  assert.equal(job.error, 'job.error.agentFinalAnswerInvalid');
});

test('parseError: Werkzeug wird nicht mit {} ausgeführt, Modell bekommt ehrliches tool_result', async () => {
  const calls = mockCalls([
    res({ stopReason: 'tool_use', toolUses: [{ id: 'l1', name: 'lookup', input: {}, parseError: 'Bad JSON' }, { id: 'f0', name: 'final_answer', input: {}, parseError: 'x' }] }),
    res({ stopReason: 'tool_use', toolUses: [tu('final_answer', { antwort: 'zweiter Anlauf' })] }),
  ]);
  const job = makeJob();
  const out = await runJob(job, newSession());
  assert.equal(out.content, 'zweiter Anlauf');
  assert.deepEqual(job.executed, []);
  const results = calls[1].messages.at(-1).content;
  assert.equal(results.length, 2, 'jeder tool_use bekommt genau ein tool_result');
  assert.ok(results.every(r => r.is_error && /kein gültiges JSON/.test(r.content)));
  assert.doesNotMatch(results[0].content, /errorKey/, 'UI-Key geht nicht ans Modell');
});

test('Deckel pro Runde: überzählige Aufrufe bekommen ein tool_result statt ausgeführt zu werden', async () => {
  const calls = mockCalls([
    res({ stopReason: 'tool_use', toolUses: [tu('lookup', {}, 'a'), tu('lookup', {}, 'b'), tu('lookup', {}, 'c')] }),
    res({ stopReason: 'tool_use', toolUses: [tu('final_answer', { antwort: 'ok' })] }),
  ]);
  const job = makeJob({ prep: { maxToolsPerRound: 2 } });
  await runJob(job, newSession());
  assert.equal(job.executed.length, 2);
  const results = calls[1].messages.at(-1).content;
  assert.deepEqual(results.map(r => r.tool_use_id), ['a', 'b', 'c']);
  assert.equal(results[2].is_error, true);
  assert.match(results[2].content, /höchstens 2/);
  const log = job.ctx().toolLog;
  assert.equal(log[2].errorKey, 'chat.toolError.roundLimit');
});

test('Kontextfenster-Schutz vor dem Call: Synthese mit gekürzten Ergebnissen der letzten Runde', async () => {
  const calls = mockCalls([
    res({ stopReason: 'tool_use', tokensIn: 100, toolUses: [tu('lookup')] }),
    res({ stopReason: 'tool_use', toolUses: [tu('final_answer', { antwort: 'gekürzt synthetisiert' })] }),
  ]);
  const job = makeJob({ prep: { tokenBudget: 2000, inputCapInstruction: 'BUDGET' }, toolResult: () => ({ text: 'x'.repeat(40000) }) });
  const out = await runJob(job, newSession());
  assert.equal(out.content, 'gekürzt synthetisiert');
  assert.equal(out.ci.stop, 'context_budget');
  assert.equal(calls.length, 2, 'keine zweite Recherche-Runde');
  assert.deepEqual(calls[1].tools, ['final_answer']);
  const toolMsg = calls[1].messages.at(-2).content;
  assert.match(toolMsg[0].content, /gekürzt: Kontext-Budget/);
  assert.ok(toolMsg[0].content.length < 40000);
});

test('AI_TOOLS_UNSUPPORTED nach beantworteter Runde: kein Rückfall, Job-Fehler', async () => {
  let n = 0;
  ai.callAIWithTools = async () => {
    n++;
    if (n === 1) return res({ stopReason: 'tool_use', toolUses: [tu('lookup')] });
    const e = new Error('tools nicht unterstützt'); e.code = 'AI_TOOLS_UNSUPPORTED'; throw e;
  };
  let fellBack = false;
  await runFailing(makeJob({ fallbackJob: async () => { fellBack = true; } }), newSession());
  assert.equal(fellBack, false);
});

test('userPreamble + cacheHistory: Erst-Kontext vor der Frage, Breakpoint am Historien-Ende', async () => {
  const sid = newSession();
  // Verlauf: frühere Runde + aktuelle Frage (newSession legte 'Frage?' an).
  db.prepare(`DELETE FROM chat_messages WHERE session_id = ?`).run(sid);
  const ins = db.prepare(`INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)`);
  ins.run(sid, 'user', 'alt', '2026-01-01T00:00:01Z');
  ins.run(sid, 'assistant', 'alte Antwort', '2026-01-01T00:00:02Z');
  ins.run(sid, 'user', 'Frage?', '2026-01-01T00:00:03Z');
  const calls = mockCalls([res({ stopReason: 'tool_use', toolUses: [tu('final_answer', { antwort: 'ok' })] })]);
  await runJob(makeJob({ prep: { userPreamble: 'ERST-KONTEXT', cacheHistory: true } }), sid);
  const msgs = calls[0].messages;
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1].cacheBreakpoint, true);
  assert.deepEqual(msgs[2].content.map(b => b.text.trim()), ['ERST-KONTEXT', 'Frage?']);
  const stored = db.prepare(`SELECT content FROM chat_messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC`).get(sid);
  assert.equal(stored.content, 'Frage?', 'persistiert wird nur die Frage');
});

test('buildAgenticHistory: Rollen alternieren ab user, Marker neutralisiert, Belege angehängt', () => {
  const { buildAgenticHistory } = require('../../routes/jobs/agentic-chat');
  const sid = newSession();
  db.prepare(`DELETE FROM chat_messages WHERE session_id = ?`).run(sid);
  const ins = db.prepare(`INSERT INTO chat_messages (session_id, role, content, context_info, created_at) VALUES (?, ?, ?, ?, ?)`);
  let t = 0;
  const at = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++t)).toISOString();
  ins.run(sid, 'user', 'Anker-Frage', null, at());
  ins.run(sid, 'assistant', 'Anker-Antwort', null, at());
  for (let i = 0; i < 6; i++) {
    ins.run(sid, 'user', `F${i}`, null, at());
    const ci = i === 5 ? JSON.stringify({ citations: [{ n: 1, page_id: 7, page_name: 'Kap 1', quote: 'Stefan war achtundzwanzig.', valid: true }, { n: 2, quote: 'erfunden', valid: false }] }) : null;
    ins.run(sid, 'assistant', i === 4 ? '__i18n:chat.errors.maxIterReached__' : `A${i}`, ci, at());
  }
  ins.run(sid, 'user', 'aktuell', null, at());
  // 15 Nachrichten, Tail von 8 beginnt mit einer Antwort (A2) → muss wegfallen.
  const h = buildAgenticHistory(sid, 8);
  assert.deepEqual(h.slice(0, 3).map(m => m.content), ['Anker-Frage', 'Anker-Antwort', 'F3']);
  assert.equal(h[0].role, 'user');
  for (let i = 1; i < h.length; i++) assert.notEqual(h[i].role, h[i - 1].role, `Rollen-Folge bei ${i}`);
  assert.equal(h.at(-1).content, 'aktuell');
  const joined = h.map(m => m.content).join('\n');
  assert.doesNotMatch(joined, /__i18n:/);
  assert.match(joined, /Keine inhaltliche Antwort/);
  assert.match(joined, /Belege dieser Antwort: \(1\) Abschnitt «Kap 1» \(page_id 7\): «Stefan war achtundzwanzig\.»/);
  assert.doesNotMatch(joined, /erfunden/);
});

test('_handleChatPost: laufender Job derselben Session → 409, Nachricht wird nicht gespeichert', () => {
  const { _handleChatPost } = require('../../routes/jobs/chat/shared');
  const sid = newSession();
  const before = db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?`).get(sid).n;
  const running = createJob('book-chat', BOOK, USER, 'x', null, sid);
  let status = 200, body = null;
  const resStub = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  _handleChatPost({ body: { session_id: sid, message: 'Neue Frage' }, session: { user: { email: USER } } }, resStub, {
    jobType: 'book-chat', kind: 'book', labelFn: () => ({ key: 'x' }), runFn: () => {},
  });
  assert.equal(status, 409);
  assert.deepEqual(body, { error_code: 'CHAT_JOB_RUNNING', jobId: running });
  const after = db.prepare(`SELECT COUNT(*) AS n FROM chat_messages WHERE session_id = ?`).get(sid).n;
  assert.equal(after, before);
});
