'use strict';
// Integration: ein Recherche-Chat-Lauf auf dem Suchweg SearXNG mit einem
// openai-compat-Provider. Provider-Call (callAIWithTools), SearXNG und der
// Seitenabruf sind gestubbt; alles dazwischen ist echt — Gate, Job-Prepare,
// Werkzeugliste, Handler, Loop, context_info, Kosten, Persistenz.
// Gegenprobe: Claude/Anthropic bekommt unverändert das Server-Tool.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const USER = 'autor@test.dev';
const BOOK = 9431;
const NOW = '2026-01-01T00:00:00.000Z';

let ctx; let db; let appSettings; let ai; let websearch; let searxng; let urlScrape;
let runResearchChatJob; let createJob; let jobs;
let realCall; let realSearch; let realScrape;

test.before(() => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  appSettings = require('../../lib/app-settings');
  ai = require('../../lib/ai');
  websearch = require('../../lib/websearch');
  searxng = require('../../lib/websearch/searxng');
  urlScrape = require('../../lib/url-scrape');
  ({ runResearchChatJob } = require('../../routes/jobs/research-chat'));
  ({ createJob, jobs } = require('../../routes/jobs/shared'));
  realCall = ai.callAIWithTools; realSearch = searxng.search; realScrape = urlScrape.scrapeUrl;

  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Gotthard', ?, ?)").run(BOOK, NOW, NOW);
  require('../../db/book-access').grantAccess(BOOK, USER, 'owner', USER);
});
test.after(() => {
  ai.callAIWithTools = realCall; searxng.search = realSearch; urlScrape.scrapeUrl = realScrape;
  websearch._setSearxngToolsReady(false);
  ctx.cleanup();
});

function newSession(question) {
  // title gesetzt → kein KI-Titel-Call am Ende.
  const id = db.prepare(
    "INSERT INTO chat_sessions (book_id, kind, user_email, title, created_at, last_message_at) VALUES (?, 'research', ?, 'T', ?, ?)"
  ).run(BOOK, USER, NOW, NOW).lastInsertRowid;
  const msgId = db.prepare("INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)")
    .run(id, question, NOW).lastInsertRowid;
  return { id, msgId };
}

const res = (over) => ({
  text: '', toolUses: [], rawContentBlocks: [], stopReason: 'end_turn',
  tokensIn: 1000, tokensOut: 50, truncated: false, model: 'local-model', ...over,
});
const tu = (id, name, input) => ({ id, name, input });
const toolTurn = (...uses) => res({
  stopReason: 'tool_use', toolUses: uses,
  rawContentBlocks: uses.map(u => ({ type: 'tool_use', id: u.id, name: u.name, input: u.input })),
});

async function run(question, seq) {
  const calls = [];
  ai.callAIWithTools = async (messages, system, tools, _p, _x, _sig, provider) => {
    calls.push({ messages: structuredClone(messages), tools: structuredClone(tools), provider });
    const next = seq.shift();
    if (!next) throw new Error('Mock-Sequenz erschöpft');
    return next;
  };
  const s = newSession(question);
  const jobId = createJob('research-chat', BOOK, USER, 'x');
  await runResearchChatJob(jobId, s.id, s.msgId, question, USER);
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', `Job nicht done: ${JSON.stringify(j.error)}`);
  const msg = db.prepare('SELECT content, web_searches, provider, context_info FROM chat_messages WHERE id = ?')
    .get(j.result.assistant_message_id);
  return { calls, msg, ci: JSON.parse(msg.context_info) };
}

test('openai-compat + SearXNG: Suche, Seite lesen, belegte Antwort, keine Suchkosten', async () => {
  websearch._setSearxngToolsReady(true);
  appSettings.set('ai.provider', 'openai-compat');
  appSettings.set('websearch.provider', 'searxng');
  appSettings.set('websearch.searxng.url', 'http://searx.test');
  appSettings.set('research_chat.enabled', true);

  const searches = [];
  searxng.search = async (q, opts) => {
    searches.push({ q, opts });
    return {
      results: [
        { title: 'Gotthard-Basistunnel', url: 'https://de.wikipedia.org/wiki/Gotthard-Basistunnel', snippet: 'Eröffnung 2016', engines: ['g'], published: null },
        { title: 'NEAT', url: 'https://www.uvek.admin.ch/de/neat', snippet: 'NEAT', engines: ['d'], published: null },
      ],
      unresponsive: [],
    };
  };
  const scraped = [];
  urlScrape.scrapeUrl = async (u) => { scraped.push(u); return { title: 'Gotthard-Basistunnel', text: 'Eröffnet am 1. Juni 2016.', finalUrl: u }; };

  const { calls, msg, ci } = await run('Wann wurde der Gotthard-Basistunnel eröffnet? Siehe auch https://user.example/notiz', [
    toolTurn(tu('a', 'web_search', { query: 'Gotthard-Basistunnel Eröffnung' })),
    toolTurn(
      tu('b', 'read_web_page', { url: 'https://de.wikipedia.org/wiki/Gotthard-Basistunnel' }),
      tu('c', 'read_web_page', { url: 'https://evil.example/?leak=1' }),
    ),
    toolTurn(tu('d', 'final_answer', {
      antwort: 'Am 1. Juni 2016 [1].',
      quellen: [
        { url: 'https://de.wikipedia.org/wiki/Gotthard-Basistunnel', titel: 'Wikipedia' },
        { url: 'https://erfunden.example/x' },
      ],
    })),
  ]);

  // Werkzeugliste: Function-Tools statt Server-Tool, über alle Runden identisch.
  const first = calls[0].tools;
  assert.ok(first.every(t => !t.type), 'kein Server-Tool');
  assert.ok(first.every(t => t.max_uses === undefined), 'Deckel liegt im Handler, nicht am Werkzeug');
  assert.ok(first.find(t => t.name === 'read_web_page'));
  for (const c of calls) assert.deepEqual(c.tools, first, 'Werkzeugliste bleibt konstant');
  assert.notEqual(calls[0].provider, 'claude', 'Provider nicht auf Claude erzwungen');

  // Handler: Suche mit Buchsprache, fremde URL nicht abgerufen.
  assert.equal(searches.length, 1);
  assert.equal(searches[0].opts.language, 'de');
  assert.deepEqual(scraped, ['https://de.wikipedia.org/wiki/Gotthard-Basistunnel']);
  const toolResults = calls[2].messages.at(-1).content;
  assert.ok(toolResults.find(r => r.tool_use_id === 'c').is_error, 'fremde URL als Fehler-Result');

  // Antwort + context_info
  assert.equal(msg.content, 'Am 1. Juni 2016 [1].');
  assert.equal(ci.web_searches, 1);
  assert.deepEqual(ci.web_queries, ['Gotthard-Basistunnel Eröffnung']);
  assert.deepEqual(ci.sources.map(s => s.url), [
    'https://de.wikipedia.org/wiki/Gotthard-Basistunnel', 'https://www.uvek.admin.ch/de/neat',
  ]);
  assert.deepEqual(ci.answer_sources.map(s => s.url), ['https://de.wikipedia.org/wiki/Gotthard-Basistunnel'],
    'erfundene Quelle verworfen');
  assert.deepEqual(ci.answer_sources[0].doc_nums, [1]);

  // Kosten: keine bezahlte Websuche.
  assert.equal(msg.web_searches, 0);
  assert.equal(msg.provider, 'openai-compat');
});

test('Suchdeckel: Handler lehnt ab, Loop beendet die Recherche mit web_cap', async () => {
  websearch._setSearxngToolsReady(true);
  appSettings.set('ai.provider', 'openai-compat');
  appSettings.set('jobs.research_chat.max_web_searches', 2);
  let n = 0;
  searxng.search = async () => ({ results: [{ title: `T${++n}`, url: `https://ex.com/${n}`, snippet: '', engines: [], published: null }], unresponsive: [] });
  try {
    const { calls, ci } = await run('Frage', [
      // Drei Suchen in einer Runde: die dritte trifft den Deckel im Handler.
      toolTurn(tu('a', 'web_search', { query: 'eins' }), tu('b', 'web_search', { query: 'zwei' }), tu('c', 'web_search', { query: 'drei' })),
      // Synthese-Turn (stopBeforeRound → web_cap).
      toolTurn(tu('d', 'final_answer', { antwort: 'Zusammenfassung' })),
    ]);
    assert.equal(n, 2, 'nur zwei echte Suchen');
    assert.equal(ci.web_searches, 2);
    assert.equal(ci.stop_reason, 'web_cap');
    const third = calls[1].messages.find(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(r => r.tool_use_id === 'c'));
    assert.ok(third.content.find(r => r.tool_use_id === 'c').is_error);
  } finally {
    appSettings.set('jobs.research_chat.max_web_searches', 10);
  }
});

test('Gegenprobe Claude/Anthropic: Server-Tool, keine Function-Tools, Provider erzwungen wie bisher nicht nötig', async () => {
  websearch._setSearxngToolsReady(true);
  appSettings.set('ai.provider', 'claude');
  appSettings.set('ai.claude.api_key', 'sk-test');
  appSettings.set('websearch.claude', 'anthropic');
  const { calls, msg } = await run('Frage', [
    res({
      stopReason: 'tool_use',
      toolUses: [tu('z', 'final_answer', { antwort: 'ok' })],
      rawContentBlocks: [
        { type: 'server_tool_use', name: 'web_search', input: { query: 'q' } },
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.ch/', title: 'A' }] },
        { type: 'tool_use', id: 'z', name: 'final_answer', input: { antwort: 'ok' } },
      ],
      model: 'claude-sonnet-4-6',
    }),
  ]);
  const web = calls[0].tools.find(t => t.name === 'web_search');
  assert.equal(web.type, 'web_search_20250305');
  assert.ok(!calls[0].tools.find(t => t.name === 'read_web_page'));
  assert.equal(msg.web_searches, 1, 'Anthropic-Suche bleibt bezahlt gezählt');
});
