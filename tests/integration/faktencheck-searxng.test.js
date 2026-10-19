'use strict';
// Weltfakten-Faktencheck auf dem Suchweg SearXNG:
//  - factcheckGate: Kill-Switch, Suchweg je Provider (dieselbe Lesart wie /config)
//  - judgeWithSearxng: Werkzeug-Runden, Deckel, Lesen nur aus Treffern, Abbruch ohne Urteil
//  - kompletter Lauf mit openai-compat: «falsch» nur mit gesehener Quelle, sonst «unklar»
// Provider-Call, SearXNG und Seitenabruf sind gestubbt.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bootstrap } = require('./_helpers/setup');

const BOOK = 9461;
const USER = 'autor@test.dev';
const NOW = '2026-01-01T00:00:00.000Z';
const HIT = 'https://de.wikipedia.org/wiki/Apollo_11';

let ctx; let db; let appSettings; let ai; let searxng; let urlScrape;
let factcheckGate; let judgeWithSearxng; let makeEvidence; let MAX_SEARCHES;
let realCall; let realSearch; let realScrape;

before(() => {
  ctx = bootstrap();
  ({ db } = require('../../db/connection'));
  appSettings = require('../../lib/app-settings');
  ai = require('../../lib/ai');
  searxng = require('../../lib/websearch/searxng');
  urlScrape = require('../../lib/url-scrape');
  ({ factcheckGate } = require('../../lib/factcheck-gate'));
  ({ judgeWithSearxng, makeEvidence, MAX_SEARCHES } = require('../../routes/jobs/komplett/factcheck-web'));
  realCall = ai.callAIWithTools; realSearch = searxng.search; realScrape = urlScrape.scrapeUrl;

  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Mondbuch', ?, ?)").run(BOOK, NOW, NOW);
  db.prepare('INSERT INTO book_settings (book_id, weltfakten_real_pruefen, updated_at) VALUES (?, 1, ?)').run(BOOK, NOW);
  const ins = db.prepare('INSERT INTO world_facts (book_id, user_email, kategorie, subjekt, fakt, sort_order) VALUES (?,?,?,?,?,?)');
  ins.run(BOOK, USER, 'historie', 'Mondlandung', 'fand 1968 statt', 0);
  ins.run(BOOK, USER, 'technik', 'Smartphone', 'gab es 1985', 1);
  ins.run(BOOK, USER, 'ereignis', 'Mauerfall', 'war 1989', 2);
});
after(() => {
  ai.callAIWithTools = realCall; searxng.search = realSearch; urlScrape.scrapeUrl = realScrape;
  ctx.cleanup();
});

function useSearxng(provider = 'openai-compat') {
  appSettings.set('ai.provider', provider);
  appSettings.set('ai.komplett.factcheck', true);
  appSettings.set('websearch.provider', 'searxng');
  appSettings.set('websearch.searxng.url', 'http://searx.test');
}

const res = (over) => ({ text: '', toolUses: [], rawContentBlocks: [], stopReason: 'end_turn', tokensIn: 10, tokensOut: 5, ...over });
const toolTurn = (...uses) => res({
  stopReason: 'tool_use', toolUses: uses,
  rawContentBlocks: uses.map(u => ({ type: 'tool_use', id: u.id, name: u.name, input: u.input })),
});

// ── Gate ─────────────────────────────────────────────────────────────────────

test('factcheckGate: Kill-Switch, dann Suchweg je Provider', () => {
  appSettings.set('ai.komplett.factcheck', false);
  appSettings.set('ai.provider', 'claude');
  assert.equal(factcheckGate(USER).error_code, 'FACTCHECK_DISABLED');

  appSettings.set('ai.komplett.factcheck', true);
  assert.equal(factcheckGate(USER), null, 'Claude über Anthropic');

  appSettings.set('ai.provider', 'ollama');
  assert.deepEqual(factcheckGate(USER), { status: 400, error_code: 'FACTCHECK_NO_TOOLS', i18nKey: 'job.error.factcheckNoTools' });

  appSettings.set('ai.provider', 'openai-compat');
  appSettings.set('websearch.provider', 'off');
  assert.equal(factcheckGate(USER).error_code, 'FACTCHECK_NO_WEBSEARCH');

  useSearxng();
  assert.equal(factcheckGate(USER), null);
  appSettings.set('ai.komplett.factcheck', false);
  assert.equal(factcheckGate(USER).error_code, 'FACTCHECK_DISABLED', 'Kill-Switch schlägt den Suchweg');
});

// ── Judge-Schleife ───────────────────────────────────────────────────────────

function judgeArgs(seq, over = {}) {
  const calls = [];
  const evidence = makeEvidence();
  return {
    calls, evidence,
    args: {
      messages0: [{ role: 'user', content: 'Prüfe' }], system: 'sys', tools: [{ name: 'web_search' }, { name: 'read_web_page' }],
      provider: 'openai-compat', evidence, language: 'de', signal: null, maxTokensOut: 1000,
      onCall: () => {},
      callTools: async (messages, _s, _t, _p, _x, _sig, provider) => {
        calls.push({ messages: structuredClone(messages), provider });
        const next = seq.shift();
        if (!next) throw new Error('Mock-Sequenz erschöpft');
        return next;
      },
      ...over,
    },
  };
}

test('judgeWithSearxng: suchen, Treffer lesen, Urteil als Text; fremde URL nicht gelesen', async () => {
  const searches = [];
  searxng.search = async (q, o) => { searches.push({ q, o }); return { results: [{ title: 'Apollo 11', url: HIT, snippet: '1969', engines: [], published: null }], unresponsive: [] }; };
  const read = [];
  urlScrape.scrapeUrl = async (u) => { read.push(u); return { title: 'Apollo 11', text: 'Landung am 20. Juli 1969.', finalUrl: u }; };
  const { calls, evidence, args } = judgeArgs([
    toolTurn({ id: 'a', name: 'web_search', input: { query: 'Mondlandung Jahr' } }),
    toolTurn({ id: 'b', name: 'read_web_page', input: { url: 'https://evil.example/' } }, { id: 'c', name: 'read_web_page', input: { url: HIT } }),
    res({ text: '{"urteil":"falsch","quelle":"' + HIT + '"}' }),
  ]);
  const text = await judgeWithSearxng(args);
  assert.match(text, /"urteil":"falsch"/);
  assert.equal(calls[0].provider, 'openai-compat');
  assert.equal(searches[0].o.language, 'de');
  assert.deepEqual(read, [HIT], 'nur die Treffer-URL gelesen');
  const results = calls[2].messages.at(-1).content;
  assert.ok(results.find(r => r.tool_use_id === 'b').is_error);
  assert.ok(evidence.has(HIT));
  assert.ok(!evidence.has('https://evil.example/'));
});

test('judgeWithSearxng: Suchdeckel je Fakt, Werkzeuge bis zur letzten Runde → kein Urteil', async () => {
  let n = 0;
  searxng.search = async () => { n++; return { results: [], unresponsive: [] }; };
  const turns = Array.from({ length: 10 }, (_, i) => toolTurn({ id: `s${i}`, name: 'web_search', input: { query: `q${i}` } }));
  const { args } = judgeArgs(turns);
  await assert.rejects(() => judgeWithSearxng(args), (e) => e.message === 'job.error.factcheckVerdictInvalid');
  assert.equal(n, MAX_SEARCHES, 'mehr Suchen als der Deckel laufen nicht');
});

test('judgeWithSearxng: gesperrte Engines → Fehler-Result «Ausfall», nicht leere Trefferliste', async () => {
  searxng.search = async () => ({ results: [], unresponsive: ['brave: too many requests', 'duckduckgo: CAPTCHA'] });
  const { calls, args } = judgeArgs([
    toolTurn({ id: 'a', name: 'web_search', input: { query: 'q' } }),
    res({ text: '{"urteil":"unklar"}' }),
  ]);
  await judgeWithSearxng(args);
  const r = calls[1].messages.at(-1).content[0];
  assert.equal(r.is_error, true);
  assert.match(r.content, /gesperrt/);
});

test('judgeWithSearxng: abgeschnittene Runde wirft vor dem Parsen', async () => {
  const { args } = judgeArgs([res({ text: '{"urteil":"fal', truncated: true, stopReason: 'max_tokens', tokensOut: 1000 })]);
  await assert.rejects(() => judgeWithSearxng(args), (e) => e.message === 'job.error.aiTruncated');
});

// ── Kompletter Lauf ──────────────────────────────────────────────────────────

test('runFaktencheckJob mit openai-compat: «falsch» nur mit gesehener Quelle', async () => {
  useSearxng();
  searxng.search = async () => ({ results: [{ title: 'Apollo 11', url: HIT, snippet: '1969', engines: [], published: null }], unresponsive: [] });
  const providers = new Set();
  ai.callAIWithTools = async (messages, _system, tools, _p, _x, _sig, provider) => {
    providers.add(provider);
    assert.ok(tools.every(t => !t.type), 'Function-Tools, kein Server-Tool');
    const prompt = String(messages[0].content);
    if (messages.length === 1) return toolTurn({ id: 'w', name: 'web_search', input: { query: 'q' } });
    // Mondlandung: Quelle gesehen → bleibt «falsch». Smartphone: Quelle aus dem
    // Gedächtnis → muss «unklar» werden. Mauerfall: korrekt.
    if (prompt.includes('Mondlandung')) return res({ text: `{"urteil":"falsch","schwere":"mittel","beschreibung":"1969","quelle":"${HIT}"}` });
    if (prompt.includes('Smartphone')) return res({ text: '{"urteil":"falsch","schwere":"mittel","beschreibung":"x","quelle":"https://erfunden.example/handy"}' });
    return res({ text: '{"urteil":"korrekt"}' });
  };

  const { runFaktencheckJob } = require('../../routes/jobs/komplett/job-faktencheck');
  const { createJob, jobs } = require('../../routes/jobs/shared');
  const jobId = createJob('faktencheck', BOOK, USER, 'x');
  await runFaktencheckJob(jobId, BOOK, 'Mondbuch', USER);
  const j = jobs.get(jobId);
  assert.equal(j.status, 'done', JSON.stringify(j.error));
  assert.deepEqual([...providers], ['openai-compat']);
  assert.equal(j.result.checked, 3);

  const verdicts = Object.fromEntries(db.prepare('SELECT fact_key, urteil FROM world_fact_verdicts WHERE book_id = ?').all(BOOK)
    .map(r => [r.fact_key, r.urteil]));
  const by = (needle) => Object.entries(verdicts).find(([k]) => k.toLowerCase().includes(needle))?.[1];
  assert.equal(by('mondlandung'), 'falsch');
  assert.equal(by('smartphone'), 'unklar', 'ungesehene Quelle belegt nichts');
  assert.equal(by('mauerfall'), 'korrekt');
  assert.equal(j.result.count, 1);
  assert.equal(j.result.issues[0].quelle, HIT);
});

test('runFaktencheckJob: Gate im Job — Websuche zwischen POST und Start abgeschaltet', async () => {
  useSearxng();
  appSettings.set('websearch.provider', 'off');
  const { runFaktencheckJob } = require('../../routes/jobs/komplett/job-faktencheck');
  const { createJob, jobs } = require('../../routes/jobs/shared');
  const jobId = createJob('faktencheck', BOOK, USER, 'x');
  await runFaktencheckJob(jobId, BOOK, 'Mondbuch', USER);
  const j = jobs.get(jobId);
  assert.equal(j.status, 'error');
  assert.match(JSON.stringify(j.error), /factcheckNoWebsearch/);
});
