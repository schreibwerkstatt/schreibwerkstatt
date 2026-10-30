'use strict';
// Ideen-Chat-Job (routes/jobs/ideen-chat.js) einmal komplett mit gemocktem
// Provider: System-Prompt trägt Ideen + Gliederung + Stufen, Werkzeugsatz =
// Lese-Teilmenge des Buch-Chats + propose_*, ein Vorschlag landet in
// context_info.proposals, die Ideen bleiben unverändert. Dazu der klassische
// Pfad und der Laufzeit-Rückfall.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('ideen-chat-job');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const ideenDb = require('../../db/ideen');
const appSettings = require('../../lib/app-settings');
const ai = require('../../lib/ai');
const { createJob, jobs } = require('../../routes/jobs/shared');
const { runIdeenChatJob, runIdeenChatJobDispatch } = require('../../routes/jobs/ideen-chat');

const USER = 'ideenjob@example.com';
const BOOK = 81201;
const NOW = '2026-01-01T00:00:00.000Z';
appUsers.createUser({ email: USER });
db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Ideenbuch', ?, ?)`).run(BOOK, NOW, NOW);
appSettings.set('ai.provider', 'claude');
const ch = db.prepare('INSERT INTO chapters (book_id, chapter_name) VALUES (?, ?)').run(BOOK, 'Anfang').lastInsertRowid;
const PAGE = 8120101;
db.prepare(`INSERT INTO pages (page_id, book_id, chapter_id, page_name, body_html, updated_at) VALUES (?, ?, ?, 'Szene eins', '<p>Sie schliesst die Tür ab.</p>', ?)`).run(PAGE, BOOK, ch, NOW);
const idee = ideenDb.createIdee({ bookId: BOOK, pageId: PAGE, userEmail: USER, content: 'Tür abschliessen lassen' });
const bookIdee = ideenDb.createIdee({ bookId: BOOK, userEmail: USER, content: 'Nachbarin einführen' });

function newSession() {
  const id = db.prepare(`INSERT INTO chat_sessions (book_id, kind, user_email, title, created_at, last_message_at)
                         VALUES (?, 'ideen', ?, 'T', ?, ?)`).run(BOOK, USER, NOW, NOW).lastInsertRowid;
  db.prepare(`INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, 'user', 'Erledigt?', ?)`).run(id, NOW);
  return id;
}

const res = (over) => ({
  text: '', toolUses: [], rawContentBlocks: [], stopReason: 'end_turn',
  tokensIn: 100, tokensOut: 10, truncated: false, model: 'claude-sonnet-4-6', ...over,
});
const statusOf = (id) => db.prepare('SELECT status FROM ideen WHERE id = ?').get(id).status;

test('Erledigt-Vorschlag mit Beleg landet in context_info.proposals, Idee unverändert', async () => {
  const calls = [];
  ai.callAIWithTools = async (messages, system, tools) => {
    calls.push({ system, messages: [...messages], tools: tools.map(t => t.name) });
    if (calls.length === 1) {
      return res({
        stopReason: 'tool_use',
        toolUses: [{ id: 't1', name: 'propose_idee', input: {
          idee_id: idee, status: 'erledigt', beleg: 'Sie schliesst die Tür ab.', beleg_page_id: PAGE, begruendung: 'steht im Text',
        } }],
        rawContentBlocks: [{ type: 'tool_use', id: 't1', name: 'propose_idee', input: {} }],
      });
    }
    return res({ stopReason: 'tool_use', toolUses: [{ id: 't2', name: 'final_answer', input: { antwort: 'Eine Pendenz ist erledigt.' } }] });
  };
  const sid = newSession();
  const jobId = createJob('ideen-chat', BOOK, USER, 'x');
  await runIdeenChatJob(jobId, sid, 1, 'Erledigt?', USER);
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', `Job nicht done: ${j.error}`);
  assert.equal(j.result.proposals, 1);

  // System-Prompt = nur der stabile Block; Board/Ideen stehen als Vorspann in der
  // aktuellen User-Nachricht (Cache-Präfix: Werkzeuge + System + Verlauf).
  const sysOnly = calls[0].system.map(b => b.text).join('\n');
  const lastUser = calls[0].messages.at(-1);
  const sysText = lastUser.content.map(b => b.text).join('');
  assert.equal(calls[0].system.length, 1, 'nur der stabile Block im System-Prompt');
  assert.doesNotMatch(sysOnly, /=== FRAGE ===/);
  assert.match(sysText, /=== FRAGE ===/);
  assert.match(sysText, new RegExp(`\\[#${idee}\\] \\(offen\\) · «Tür abschliessen lassen»`));
  assert.match(sysText, new RegExp(`\\[#${bookIdee}\\]`));
  assert.match(sysText, new RegExp(`Abschnitt \\[page#${PAGE}\\] «Szene eins»`));
  assert.match(sysText, /AKTIVE STUFEN DIESES BUCHES/);
  assert.ok(calls[0].tools.includes('get_pages'));
  assert.ok(calls[0].tools.includes('propose_idee_link'));
  assert.ok(!calls[0].tools.includes('list_ideen'), 'Ideen stehen im Prompt, kein Werkzeug dafür');
  assert.ok(!calls[0].tools.includes('generate_image'));
  // Doppelungen sind eine Pendenz-Quelle des Ideen-Chats, aber nur mit Redundanz-Lauf:
  // ohne Daten im Buch wird das Werkzeug nicht angeboten (chat-tools AVAILABILITY).
  assert.ok(!calls[0].tools.includes('list_redundancies'), 'ohne Redundanz-Lauf nicht angeboten');

  const msg = db.prepare('SELECT content, context_info FROM chat_messages WHERE id = ?').get(j.result.assistant_message_id);
  const ci = JSON.parse(msg.context_info);
  assert.equal(msg.content, 'Eine Pendenz ist erledigt.');
  assert.equal(ci.mode, 'ideen');
  assert.equal(ci.proposals[0].type, 'idee_update');
  assert.equal(ci.proposals[0].beleg.page_id, PAGE);
  assert.equal(statusOf(idee), 'offen', 'Vorschlag schreibt nicht');
});

test('Nur Vorschläge, leere Antwort → eigener Hinweis-Marker', async () => {
  ai.callAIWithTools = async () => res({
    stopReason: 'tool_use',
    toolUses: [
      { id: 'p', name: 'propose_idee', input: { idee_id: bookIdee, chapter_id: ch, begruendung: 'passt' } },
      { id: 'f', name: 'final_answer', input: { antwort: '' } },
    ],
  });
  const sid = newSession();
  const jobId = createJob('ideen-chat', BOOK, USER, 'x');
  await runIdeenChatJob(jobId, sid, 1, 'Orte?', USER);
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', `Job nicht done: ${j.error}`);
  const msg = db.prepare('SELECT content FROM chat_messages WHERE id = ?').get(j.result.assistant_message_id);
  assert.equal(msg.content, '__i18n:ideenBoard.chat.proposalsOnly__');
});

test('Klassischer Pfad (Ollama): JSON-Vorschläge durch dieselben Handler, ungültige fallen heraus', async () => {
  appSettings.set('ai.provider', 'ollama');
  let sawSchema = null;
  ai.callAIWithTools = async () => { throw new Error('agentischer Pfad darf nicht laufen'); };
  ai.callAIChat = async (messages, system, onProgress, max, signal, provider, schema) => {
    sawSchema = schema;
    return {
      text: JSON.stringify({
        antwort: 'Zwei Vorschläge.',
        vorschlaege: [
          { werkzeug: 'propose_idee', content: 'Klassisch neu', page_id: PAGE, begruendung: 'Lücke' },
          { werkzeug: 'propose_idee', idee_id: idee, status: 'erledigt', beleg: 'erfunden', beleg_page_id: PAGE, begruendung: 'x' },
        ],
      }),
      truncated: false, tokensIn: 50, tokensOut: 20, provider: 'ollama', model: 'llama3.2',
    };
  };
  const sid = newSession();
  const jobId = createJob('ideen-chat', BOOK, USER, 'x');
  try {
    await runIdeenChatJobDispatch(jobId, sid, 1, 'Ideen?', USER);
  } finally {
    appSettings.set('ai.provider', 'claude');
  }
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', `Job nicht done: ${j.error}`);
  assert.ok(sawSchema?.properties?.vorschlaege, 'Schema für Constrained Decoding übergeben');
  const ci = JSON.parse(db.prepare('SELECT context_info FROM chat_messages WHERE id = ?').get(j.result.assistant_message_id).context_info);
  assert.equal(ci.mode, 'ideen-classic');
  assert.equal(ci.proposals.length, 1);
  assert.equal(ci.proposals[0].fields.content, 'Klassisch neu');
  assert.equal(ci.rejected, 1, 'erfundener Beleg fällt heraus');
});

test('Endpunkt lehnt Werkzeuge zur Laufzeit ab → derselbe Job klassisch', async () => {
  ai.callAIWithTools = async () => { const e = new Error('tools unsupported'); e.code = 'AI_TOOLS_UNSUPPORTED'; throw e; };
  ai.callAIChat = async () => ({
    text: JSON.stringify({ antwort: 'Klassisch beantwortet.', vorschlaege: [] }),
    truncated: false, tokensIn: 5, tokensOut: 5, provider: 'claude', model: 'claude-sonnet-4-6',
  });
  const sid = newSession();
  const jobId = createJob('ideen-chat', BOOK, USER, 'x');
  await runIdeenChatJob(jobId, sid, 1, 'Frage?', USER);
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', `Job nicht done: ${j.error}`);
  const msg = db.prepare('SELECT content FROM chat_messages WHERE id = ?').get(j.result.assistant_message_id);
  assert.equal(msg.content, 'Klassisch beantwortet.');
});

test('Gekürzte Ideenliste → list_ideen nur in diesem Lauf angeboten, Vorspann nennt es', async () => {
  const BOOK2 = 81202;
  db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Volles Ideenbuch', ?, ?)`).run(BOOK2, NOW, NOW);
  // Mehr Ideen-Text, als der Deckel (15 % des Input-Budgets) fasst.
  const { getContextConfigFor } = require('../../lib/ai');
  const budget = Math.max(6000, Math.floor(getContextConfigFor('claude').inputBudgetChars * 0.15));
  const n = Math.ceil(budget / 380) + 5;
  for (let i = 0; i < n; i++) ideenDb.createIdee({ bookId: BOOK2, userEmail: USER, content: `Idee ${i} ` + 'x'.repeat(390) });
  const sid = db.prepare(`INSERT INTO chat_sessions (book_id, kind, user_email, title, created_at, last_message_at)
                          VALUES (?, 'ideen', ?, 'T', ?, ?)`).run(BOOK2, USER, NOW, NOW).lastInsertRowid;
  db.prepare(`INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, 'user', 'Was ist offen?', ?)`).run(sid, NOW);
  const calls = [];
  ai.callAIWithTools = async (messages, system, tools) => {
    calls.push({ messages: [...messages], tools: tools.map(t => t.name) });
    if (calls.length === 1) {
      return res({
        stopReason: 'tool_use',
        toolUses: [{ id: 'l1', name: 'list_ideen', input: { limit: 5 } }],
        rawContentBlocks: [{ type: 'tool_use', id: 'l1', name: 'list_ideen', input: {} }],
      });
    }
    return res({ stopReason: 'tool_use', toolUses: [{ id: 'f', name: 'final_answer', input: { antwort: 'Gelesen.' } }] });
  };
  const jobId = createJob('ideen-chat', BOOK2, USER, 'x');
  await runIdeenChatJob(jobId, sid, 1, 'Was ist offen?', USER);
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', `Job nicht done: ${j.error}`);
  const tools = calls[0].tools;
  assert.ok(tools.includes('list_ideen'), 'list_ideen angeboten');
  assert.ok(tools.indexOf('list_ideen') < tools.indexOf('propose_idee'), 'vor den Ausgabe-Werkzeugen');
  const pre = calls[0].messages.at(-1).content.map(b => b.text).join('');
  assert.match(pre, /Ideenliste ist für den Prompt gekürzt.*`list_ideen`/);
  const ci = JSON.parse(db.prepare('SELECT context_info FROM chat_messages WHERE id = ?').get(j.result.assistant_message_id).context_info);
  const call = ci.tool_calls.find(t => t.name === 'list_ideen');
  assert.ok(call?.ok, 'list_ideen lief');
});
