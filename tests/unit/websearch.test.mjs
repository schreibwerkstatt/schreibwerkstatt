// Websuche: SearXNG-Client (Normalisierung, Dedup, Domain-Eingrenzung, Fehlerbild)
// und die Suchweg-Entscheidung webSearchStatus (Provider × Settings).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

function _bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'websearch-'));
  process.env.DB_PATH = join(dir, 'test.db');
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
  for (const key of Object.keys(require_.cache)) {
    if (key.includes('/db/') || key.includes('/lib/')) delete require_.cache[key];
  }
  require_('../../db/connection');
  require_('../../db/migrations').runMigrations();
  return {
    appSettings: require_('../../lib/app-settings'),
    websearch: require_('../../lib/websearch'),
    searxng: require_('../../lib/websearch/searxng'),
    teardown: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

/** Gestubbter fetch: merkt sich die URL, antwortet mit `body` (Objekt → JSON). */
function stubFetch(body, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    };
  };
  return { impl, calls };
}

const { parseSearxngResponse, normalizeDomain, hostMatches, buildQuery } = require_('../../lib/websearch/searxng.js');

test('parseSearxngResponse: normalisiert Felder, kappt Snippet, nur http(s)', () => {
  const { results } = parseSearxngResponse({
    results: [
      { title: '  Mondlandung \n 1969 ', url: 'https://de.wikipedia.org/wiki/Apollo_11', content: 'x'.repeat(600), engines: ['google', 'bing'], publishedDate: '2023-07-20T10:00:00' },
      { title: 'FTP', url: 'ftp://example.com/file' },
      { title: 'kaputt', url: 'nicht eine url' },
    ],
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Mondlandung 1969');
  assert.equal(results[0].url, 'https://de.wikipedia.org/wiki/Apollo_11');
  assert.ok(results[0].snippet.length <= 400);
  assert.ok(results[0].snippet.endsWith('…'));
  assert.deepEqual(results[0].engines, ['google', 'bing']);
  assert.equal(results[0].published, '2023-07-20');
});

test('parseSearxngResponse: Dubletten verschmelzen, Engines werden vereint', () => {
  const { results } = parseSearxngResponse({
    results: [
      { title: 'A', url: 'https://www.example.com/artikel/', content: '', engines: ['google'] },
      { title: 'A2', url: 'http://example.com/artikel?utm_source=x', content: 'Snippet', engines: ['duckduckgo', 'google'] },
      { title: 'B', url: 'https://example.com/anderer', engines: ['brave'] },
    ],
  });
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'A');
  assert.deepEqual(results[0].engines, ['google', 'duckduckgo']);
  assert.equal(results[0].snippet, 'Snippet', 'leeres Snippet wird aus der Dublette ergänzt');
});

test('parseSearxngResponse: Domain-Nachfilter greift auch ohne Operator-Treue der Engine', () => {
  const { results } = parseSearxngResponse({
    results: [
      { title: 'drin', url: 'https://www.zeit.de/a' },
      { title: 'sub', url: 'https://blog.zeit.de/b' },
      { title: 'fremd', url: 'https://spiegel.de/c' },
      { title: 'Suffix-Falle', url: 'https://notzeit.de/d' },
    ],
  }, { domains: ['zeit.de'] });
  assert.deepEqual(results.map(r => r.title), ['drin', 'sub']);
});

test('parseSearxngResponse: maxResults + unresponsive_engines', () => {
  const json = {
    results: Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, url: `https://ex.com/${i}` })),
    unresponsive_engines: [['brave', 'too many requests'], ['duckduckgo', 'CAPTCHA']],
  };
  const out = parseSearxngResponse(json, { maxResults: 5 });
  assert.equal(out.results.length, 5);
  assert.deepEqual(out.unresponsive, ['brave: too many requests', 'duckduckgo: CAPTCHA']);
});

test('parseSearxngResponse: Müll-Eingaben ergeben leere Liste', () => {
  assert.deepEqual(parseSearxngResponse(null).results, []);
  assert.deepEqual(parseSearxngResponse({ results: 'x' }).results, []);
});

test('normalizeDomain / hostMatches / buildQuery', () => {
  assert.equal(normalizeDomain('https://www.Zeit.de/pfad?x=1'), 'zeit.de');
  assert.equal(normalizeDomain('*.admin.ch'), 'admin.ch');
  assert.equal(normalizeDomain('localhost'), null);
  assert.equal(normalizeDomain(''), null);
  assert.ok(hostMatches('www.admin.ch', ['admin.ch']));
  assert.ok(hostMatches('bfs.admin.ch', ['admin.ch']));
  assert.ok(!hostMatches('fakeadmin.ch', ['admin.ch']));
  assert.equal(buildQuery('Gotthard', []), 'Gotthard');
  assert.equal(buildQuery('Gotthard', ['admin.ch', 'sbb.ch']), 'Gotthard (site:admin.ch OR site:sbb.ch)');
});

test('search: baut Request, filtert Domains, liefert Treffer', async () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('websearch.searxng.url', 'http://searx.test:8888/');
    const { impl, calls } = stubFetch({
      results: [
        { title: 'Treffer', url: 'https://www.admin.ch/x', content: 'Snippet' },
        { title: 'Fremd', url: 'https://example.org/y' },
      ],
    });
    const out = await ctx.searxng.search('Gotthard Eröffnung', {
      domains: ['https://www.admin.ch/'], language: 'de', fetchImpl: impl,
    });
    assert.equal(calls.length, 1);
    const u = new URL(calls[0]);
    assert.equal(u.origin + u.pathname, 'http://searx.test:8888/search');
    assert.equal(u.searchParams.get('format'), 'json');
    assert.equal(u.searchParams.get('language'), 'de');
    assert.equal(u.searchParams.get('q'), 'Gotthard Eröffnung (site:admin.ch)');
    assert.deepEqual(out.results.map(r => r.title), ['Treffer']);
  } finally { ctx.teardown(); }
});

test('search: leere Query → kein Request', async () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('websearch.searxng.url', 'http://searx.test');
    const { impl, calls } = stubFetch({ results: [] });
    assert.deepEqual(await ctx.searxng.search('   ', { fetchImpl: impl }), { results: [], unresponsive: [] });
    assert.equal(calls.length, 0);
  } finally { ctx.teardown(); }
});

test('search: nicht konfiguriert / HTTP-Fehler / kaputtes JSON → WEBSEARCH_UNAVAILABLE', async () => {
  const ctx = _bootstrap();
  try {
    await assert.rejects(ctx.searxng.search('x', { fetchImpl: stubFetch({}).impl }), { code: 'WEBSEARCH_UNAVAILABLE' });
    ctx.appSettings.set('websearch.searxng.url', 'http://searx.test');
    await assert.rejects(ctx.searxng.search('x', { fetchImpl: stubFetch({}, { status: 502 }).impl }), { code: 'WEBSEARCH_UNAVAILABLE' });
    await assert.rejects(ctx.searxng.search('x', { fetchImpl: stubFetch('<html>').impl }), { code: 'WEBSEARCH_UNAVAILABLE' });
  } finally { ctx.teardown(); }
});

test('search: Timeout → WEBSEARCH_UNAVAILABLE, Aufrufer-Abbruch → AbortError', async () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('websearch.searxng.url', 'http://searx.test');
    ctx.appSettings.set('websearch.searxng.timeout_ms', 1000);
    const hang = (_url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    });
    await assert.rejects(ctx.searxng.search('x', { fetchImpl: hang }), { code: 'WEBSEARCH_UNAVAILABLE' });

    const ctrl = new AbortController();
    const p = ctx.searxng.search('x', { fetchImpl: hang, signal: ctrl.signal });
    ctrl.abort();
    await assert.rejects(p, (e) => e.name === 'AbortError' && e.code !== 'WEBSEARCH_UNAVAILABLE');
  } finally { ctx.teardown(); }
});

test('webSearchStatus: Claude — Anthropic per Default, SearXNG nur mit URL', () => {
  const ctx = _bootstrap();
  try {
    const s = ctx.websearch.webSearchStatus;
    assert.deepEqual(s(null), { provider: 'claude', mode: 'anthropic', reason: null });
    ctx.appSettings.set('websearch.claude', 'searxng');
    assert.equal(s(null).mode, 'anthropic', 'ohne URL zurück auf Anthropic');
    ctx.appSettings.set('websearch.searxng.url', 'http://searx.test');
    assert.equal(s(null).mode, 'searxng');
    ctx.appSettings.set('websearch.provider', 'off');
    assert.equal(s(null).mode, 'searxng', 'websearch.provider betrifft Claude nicht');
  } finally { ctx.teardown(); }
});

test('webSearchStatus: openai-compat — nur SearXNG, Tool-Calling Pflicht', () => {
  const ctx = _bootstrap();
  try {
    const s = ctx.websearch.webSearchStatus;
    ctx.appSettings.set('ai.provider', 'openai-compat');
    assert.deepEqual(s(null), { provider: 'openai-compat', mode: null, reason: 'off' });
    ctx.appSettings.set('websearch.provider', 'searxng');
    assert.equal(s(null).reason, 'off', 'searxng ohne URL zählt als aus');
    ctx.appSettings.set('websearch.searxng.url', 'http://searx.test');
    assert.deepEqual(s(null), { provider: 'openai-compat', mode: 'searxng', reason: null });
    ctx.appSettings.set('ai.openai-compat.tools', false);
    assert.deepEqual(s(null), { provider: 'openai-compat', mode: null, reason: 'no_tools' });
  } finally { ctx.teardown(); }
});

test('webSearchStatus: Ollama — kein Tool-Calling, kein Suchweg', () => {
  const ctx = _bootstrap();
  try {
    ctx.appSettings.set('ai.provider', 'ollama');
    ctx.appSettings.set('websearch.provider', 'searxng');
    ctx.appSettings.set('websearch.searxng.url', 'http://searx.test');
    assert.deepEqual(ctx.websearch.webSearchStatus(null), { provider: 'ollama', mode: null, reason: 'no_tools' });
  } finally { ctx.teardown(); }
});
