'use strict';
// Recherche-Chat, Suchweg SearXNG: Handler von web_search / read_web_page.
//  - web_search: globale Treffer-Nummern, Deckel ohne Netzwerkzugriff, Ausfall ≠ Fehlanzeige
//  - read_web_page: nur bekannte Herkunft, Kappung ausgewiesen, Redirect-Ziel gilt als belegt

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('rwt');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

require('../../db/migrations');
const { db } = require('../../db/schema');
const searxng = require('../../lib/websearch/searxng');
const urlScrape = require('../../lib/url-scrape');
const { createItem } = require('../../db/research-items');
const { executeResearchTool } = require('../../routes/jobs/research-chat-tools');
const { extractUrls } = require('../../routes/jobs/research-web-tools');

const NOW = '2026-01-01T00:00:00.000Z';
const BOOK = 72001;
db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Testbuch', ?, ?)").run(BOOK, NOW, NOW);

const realSearch = searxng.search;
const realScrape = urlScrape.scrapeUrl;
test.afterEach(() => { searxng.search = realSearch; urlScrape.scrapeUrl = realScrape; });

function mkCtx(extra = {}) {
  return { bookId: BOOK, maxWebSearches: 3, allowedDomains: [], literatureHits: [], userMessageUrls: [], ...extra };
}
function stubSearch(pages) {
  const calls = [];
  searxng.search = async (q, opts) => {
    calls.push({ q, opts });
    return { results: pages[calls.length - 1] || [], unresponsive: [] };
  };
  return calls;
}
const hit = (n) => ({ title: `T${n}`, url: `https://ex.com/${n}`, snippet: `S${n}`, engines: ['g'], published: null });

test('web_search: Treffer fortlaufend nummeriert, ctx.web gefüllt, Optionen durchgereicht', async () => {
  const calls = stubSearch([[hit(1), hit(2)], [hit(3)]]);
  const ctx = mkCtx({ allowedDomains: ['ex.com'], searchLanguage: 'de' });
  const a = await executeResearchTool('web_search', { query: 'eins' }, ctx);
  const b = await executeResearchTool('web_search', { query: 'zwei' }, ctx);
  assert.deepEqual(a.treffer.map(t => t.nr), [1, 2]);
  assert.deepEqual(b.treffer.map(t => t.nr), [3], 'Nummer läuft über Suchen hinweg weiter');
  assert.equal(ctx.web.searches, 2);
  assert.deepEqual(ctx.web.queries, ['eins', 'zwei']);
  assert.deepEqual(ctx.web.results.map(r => r.url), ['https://ex.com/1', 'https://ex.com/2', 'https://ex.com/3']);
  assert.deepEqual(calls[0].opts.domains, ['ex.com']);
  assert.equal(calls[0].opts.language, 'de');
});

test('web_search: Deckel erreicht → Fehler ohne Suche', async () => {
  const calls = stubSearch([[hit(1)], [hit(2)]]);
  const ctx = mkCtx({ maxWebSearches: 2 });
  await executeResearchTool('web_search', { query: 'a' }, ctx);
  await executeResearchTool('web_search', { query: 'b' }, ctx);
  const c = await executeResearchTool('web_search', { query: 'c' }, ctx);
  assert.equal(c.errorKey, 'chat.toolError.webSearchCap');
  assert.deepEqual(c.errorParams, { max: 2 });
  assert.equal(calls.length, 2);
  assert.equal(ctx.web.searches, 2);
});

test('web_search: leere Query, leere Treffer mit/ohne Eingrenzung, Dienst-Ausfall', async () => {
  const ctx = mkCtx();
  assert.equal((await executeResearchTool('web_search', { query: '  ' }, ctx)).errorKey, 'chat.toolError.missingParam');

  stubSearch([[]]);
  const leer = await executeResearchTool('web_search', { query: 'x' }, mkCtx({ allowedDomains: ['admin.ch'] }));
  assert.deepEqual(leer.treffer, []);
  assert.match(leer.hinweis, /admin\.ch eingegrenzt/);

  searxng.search = async () => { const e = new Error('down'); e.code = 'WEBSEARCH_UNAVAILABLE'; throw e; };
  const down = await executeResearchTool('web_search', { query: 'x' }, mkCtx());
  assert.equal(down.errorKey, 'chat.toolError.serviceUnavailable');
});

test('web_search: Job-Abbruch wird nicht verschluckt', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  searxng.search = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  await assert.rejects(executeResearchTool('web_search', { query: 'x' }, mkCtx({ jobSignal: ctrl.signal })), { name: 'AbortError' });
});

test('read_web_page: fremde URL abgelehnt, ohne Abruf', async () => {
  let fetched = 0;
  urlScrape.scrapeUrl = async () => { fetched++; return { text: 'x' }; };
  const r = await executeResearchTool('read_web_page', { url: 'https://evil.example/?d=geheim' }, mkCtx());
  assert.equal(r.errorKey, 'chat.toolError.urlNotKnown');
  assert.equal(fetched, 0);
});

test('read_web_page: erlaubte Herkünfte — Treffer, Literatur, Board, User-Nachricht', async () => {
  urlScrape.scrapeUrl = async (u) => ({ title: 'Seite', text: `Text von ${u}`, finalUrl: u });
  stubSearch([[hit(1)]]);
  const ctx = mkCtx({
    literatureHits: [{ url: 'https://doi.org/10.1/abc' }],
    userMessageUrls: extractUrls('Lies mal https://user.example/artikel, danke.'),
  });
  createItem({ bookId: BOOK, userEmail: 'u@example.com', kind: 'link', title: 'Board', urls: [{ url: 'https://board.example/x' }] });
  await executeResearchTool('web_search', { query: 'q' }, ctx);

  for (const url of ['http://www.ex.com/1/', 'https://doi.org/10.1/abc', 'https://user.example/artikel', 'https://board.example/x']) {
    const r = await executeResearchTool('read_web_page', { url }, ctx);
    assert.ok(!r.error, `${url}: ${r.error}`);
    assert.equal(r.titel, 'Seite');
  }
  assert.equal(ctx.web.pages.length, 4);
});

test('read_web_page: Kappung ausgewiesen, Redirect-Ziel als gelesene Seite vermerkt', async () => {
  urlScrape.scrapeUrl = async () => ({ title: 'Lang', text: 'a'.repeat(20000), finalUrl: 'https://ex.com/neu' });
  stubSearch([[hit(1)]]);
  const ctx = mkCtx();
  await executeResearchTool('web_search', { query: 'q' }, ctx);
  const r = await executeResearchTool('read_web_page', { url: 'https://ex.com/1' }, ctx);
  assert.equal(r.doc_truncated, true);
  assert.equal(r.doc_chars, 20000);
  assert.ok(r.text.length <= 12000);
  assert.match(r.hinweis, /Nur die ersten/);
  assert.equal(r.final_url, 'https://ex.com/neu');
  assert.deepEqual(ctx.web.pages.map(p => p.url), ['https://ex.com/1', 'https://ex.com/neu']);
});

test('read_web_page: Seite nicht lesbar → Fehler mit Code, kein Wurf', async () => {
  urlScrape.scrapeUrl = async () => { const e = new Error('blocked'); e.code = 'SCRAPE_HTTP_ERROR'; throw e; };
  stubSearch([[hit(1)]]);
  const ctx = mkCtx();
  await executeResearchTool('web_search', { query: 'q' }, ctx);
  const r = await executeResearchTool('read_web_page', { url: 'https://ex.com/1' }, ctx);
  assert.match(r.error, /SCRAPE_HTTP_ERROR/);
  assert.equal(ctx.web.pages.length, 0);
});

test('extractUrls: Satzzeichen am Ende ab, nur http(s)', () => {
  assert.deepEqual(extractUrls('Siehe https://a.ch/x. Und (http://b.de/y), ftp://c'), ['https://a.ch/x', 'http://b.de/y']);
  assert.deepEqual(extractUrls(''), []);
});
