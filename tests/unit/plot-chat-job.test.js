'use strict';
// Plot-Chat-Job (routes/jobs/plot-chat.js) einmal komplett mit gemocktem
// callAIWithTools: System-Prompt trägt Board + Figuren, Werkzeugsatz = Lese-
// Teilmenge des Buch-Chats + propose_*, ein Vorschlag landet in
// context_info.proposals, das Board bleibt unverändert.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('plot-chat-job');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const plot = require('../../db/plot');
const appSettings = require('../../lib/app-settings');
const ai = require('../../lib/ai');
const { createJob, jobs } = require('../../routes/jobs/shared');
const { runPlotChatJob } = require('../../routes/jobs/plot-chat');

const USER = 'plotjob@example.com';
const BOOK = 81101;
appUsers.createUser({ email: USER });
db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Plotbuch', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(BOOK);
appSettings.set('ai.provider', 'claude');
const act = plot.createAct(BOOK, USER, { name: 'Akt Eins' });
plot.createBeat(BOOK, act.id, USER, { titel: 'Erster Beat' });

function newSession() {
  const id = db.prepare(`INSERT INTO chat_sessions (book_id, kind, user_email, title, created_at, last_message_at)
                         VALUES (?, 'plot', ?, 'T', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(BOOK, USER).lastInsertRowid;
  db.prepare(`INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, 'user', 'Beat?', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id);
  return id;
}

const res = (over) => ({
  text: '', toolUses: [], rawContentBlocks: [], stopReason: 'end_turn',
  tokensIn: 100, tokensOut: 10, truncated: false, model: 'claude-sonnet-4-6', ...over,
});

test('Vorschlag landet in context_info.proposals, Board unverändert', async () => {
  const calls = [];
  ai.callAIWithTools = async (messages, system, tools) => {
    calls.push({ system, tools: tools.map(t => t.name) });
    if (calls.length === 1) {
      return res({
        stopReason: 'tool_use',
        toolUses: [{ id: 't1', name: 'propose_beat', input: { act_id: act.id, titel: 'Zweiter Beat', begruendung: 'Steigerung' } }],
        rawContentBlocks: [{ type: 'tool_use', id: 't1', name: 'propose_beat', input: {} }],
      });
    }
    return res({ stopReason: 'tool_use', toolUses: [{ id: 't2', name: 'final_answer', input: { antwort: 'Siehe Vorschlag.' } }] });
  };
  const beatsBefore = plot.listBeats(BOOK, USER).length;
  const sid = newSession();
  const jobId = createJob('plot-chat', BOOK, USER, 'x');
  await runPlotChatJob(jobId, sid, 1, 'Beat?', USER);
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', `Job nicht done: ${j.error}`);
  assert.equal(j.result.proposals, 1);

  const sysText = calls[0].system.map(b => b.text).join('\n');
  assert.match(sysText, new RegExp(`AKT \\[#${act.id}\\] «Akt Eins»`));
  assert.match(sysText, /«Erster Beat»/);
  assert.ok(calls[0].tools.includes('get_plot_board'));
  assert.ok(calls[0].tools.includes('propose_beat_move'));
  assert.ok(!calls[0].tools.includes('generate_image'), 'kein Bild-Werkzeug im Plot-Chat');

  const msg = db.prepare('SELECT content, context_info FROM chat_messages WHERE id = ?').get(j.result.assistant_message_id);
  const ci = JSON.parse(msg.context_info);
  assert.equal(msg.content, 'Siehe Vorschlag.');
  assert.equal(ci.mode, 'plot');
  assert.equal(ci.proposals.length, 1);
  assert.equal(ci.proposals[0].type, 'beat_create');
  assert.equal(ci.proposals[0].fields.titel, 'Zweiter Beat');
  assert.equal(plot.listBeats(BOOK, USER).length, beatsBefore);
});

test('Nur Vorschläge, leere Antwort → eigener Hinweis-Marker statt Abbruch', async () => {
  let n = 0;
  ai.callAIWithTools = async () => {
    n++;
    return res({
      stopReason: 'tool_use',
      toolUses: [
        { id: 'p', name: 'propose_act', input: { name: 'Akt Zwei', begruendung: 'fehlt' } },
        { id: 'f', name: 'final_answer', input: { antwort: '' } },
      ],
    });
  };
  const sid = newSession();
  const jobId = createJob('plot-chat', BOOK, USER, 'x');
  await runPlotChatJob(jobId, sid, 1, 'Akt?', USER);
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', `Job nicht done: ${j.error}`);
  assert.equal(n, 1);
  const msg = db.prepare('SELECT content FROM chat_messages WHERE id = ?').get(j.result.assistant_message_id);
  assert.equal(msg.content, '__i18n:plot.chat.proposalsOnly__');
});

test('Klassischer Pfad (Ollama): JSON-Vorschläge durch dieselben Handler, ungültige fallen heraus', async () => {
  const { runPlotChatJobDispatch } = require('../../routes/jobs/plot-chat');
  appSettings.set('ai.provider', 'ollama');
  let sawSchema = null;
  ai.callAIWithTools = async () => { throw new Error('agentischer Pfad darf nicht laufen'); };
  ai.callAIChat = async (messages, system, onProgress, max, signal, provider, schema) => {
    sawSchema = schema;
    return {
      text: JSON.stringify({
        antwort: 'Zwei Ideen.',
        vorschlaege: [
          { werkzeug: 'propose_beat', act_id: act.id, titel: 'Klassischer Beat', beschreibung: '', begruendung: 'passt' },
          { werkzeug: 'propose_beat', act_id: 999999, titel: 'Ins Leere', begruendung: 'falsche id' },
        ],
      }),
      truncated: false, tokensIn: 50, tokensOut: 20, provider: 'ollama', model: 'llama3.2',
    };
  };
  const sid = newSession();
  const jobId = createJob('plot-chat', BOOK, USER, 'x');
  await runPlotChatJobDispatch(jobId, sid, 1, 'Beat?', USER);
  appSettings.set('ai.provider', 'claude');
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', `Job nicht done: ${j.error}`);
  assert.ok(sawSchema?.properties?.vorschlaege, 'Schema für Constrained Decoding übergeben');
  const msg = db.prepare('SELECT content, context_info FROM chat_messages WHERE id = ?').get(j.result.assistant_message_id);
  const ci = JSON.parse(msg.context_info);
  assert.equal(msg.content, 'Zwei Ideen.');
  assert.equal(ci.mode, 'plot-classic');
  assert.equal(ci.proposals.length, 1);
  assert.equal(ci.proposals[0].fields.titel, 'Klassischer Beat');
  assert.equal(ci.proposals[0].fields.beschreibung, undefined, 'leerer String wird weggelassen');
  assert.equal(ci.rejected, 1);
});

test('Endpunkt lehnt Werkzeuge zur Laufzeit ab → derselbe Job klassisch', async () => {
  ai.callAIWithTools = async () => { const e = new Error('tools unsupported'); e.code = 'AI_TOOLS_UNSUPPORTED'; throw e; };
  ai.callAIChat = async () => ({
    text: JSON.stringify({ antwort: 'Klassisch beantwortet.', vorschlaege: [] }),
    truncated: false, tokensIn: 5, tokensOut: 5, provider: 'claude', model: 'claude-sonnet-4-6',
  });
  const sid = newSession();
  const jobId = createJob('plot-chat', BOOK, USER, 'x');
  await runPlotChatJob(jobId, sid, 1, 'Frage?', USER);
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', `Job nicht done: ${j.error}`);
  const msg = db.prepare('SELECT content FROM chat_messages WHERE id = ?').get(j.result.assistant_message_id);
  assert.equal(msg.content, 'Klassisch beantwortet.');
});

test('Klassischer Pfad: Ablehnung (stop_reason refusal) → Hinweis-Marker, Vorschläge verfallen', async () => {
  const { runPlotChatJobDispatch } = require('../../routes/jobs/plot-chat');
  const { REFUSAL_MARKER } = require('../../routes/jobs/agentic-chat');
  appSettings.set('ai.provider', 'ollama');
  ai.callAIWithTools = async () => { throw new Error('agentischer Pfad darf nicht laufen'); };
  ai.callAIChat = async () => ({
    text: JSON.stringify({ antwort: 'Teil', vorschlaege: [{ werkzeug: 'propose_beat', act_id: act.id, titel: 'X', begruendung: 'y' }] }),
    truncated: false, stopReason: 'refusal', stopDetails: { category: 'x' },
    tokensIn: 50, tokensOut: 2, provider: 'ollama', model: 'llama3.2',
  });
  const sid = newSession();
  const jobId = createJob('plot-chat', BOOK, USER, 'x');
  await runPlotChatJobDispatch(jobId, sid, 1, 'Beat?', USER);
  appSettings.set('ai.provider', 'claude');
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', `Job nicht done: ${j.error}`);
  const msg = db.prepare('SELECT content, context_info FROM chat_messages WHERE id = ?').get(j.result.assistant_message_id);
  assert.equal(msg.content, REFUSAL_MARKER);
  const ci = JSON.parse(msg.context_info);
  assert.equal(ci.refused, true);
  assert.equal(ci.proposals, undefined);
});
