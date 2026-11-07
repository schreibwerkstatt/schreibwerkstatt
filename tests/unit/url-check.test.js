'use strict';
// lib/url-check.js — Erreichbarkeit einer Fundstueck-URL (Job research-link-check).
// Kein Netz: fetchImpl/assertUrl sind die Test-Seams von safeFetch.

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkUrl } = require('../../lib/url-check');

const okHop = async () => {};
const respond = (map) => async (url, opts) => {
  const r = map[`${opts.method} ${url}`] ?? map[url];
  if (r instanceof Error) throw r;
  return new Response(null, { status: r ?? 200, headers: r >= 300 && r < 400 ? { location: 'https://b.example/' } : {} });
};

test('2xx → ok', async () => {
  assert.deepEqual(await checkUrl('https://a.example/', { fetchImpl: respond({}), assertUrl: okHop }), { ok: true, code: 200, error: null });
});

test('HEAD 405 → GET entscheidet; 404 → tot', async () => {
  const fetchImpl = respond({ 'HEAD https://a.example/': 405, 'GET https://a.example/': 404 });
  assert.deepEqual(await checkUrl('https://a.example/', { fetchImpl, assertUrl: okHop }), { ok: false, code: 404, error: null });
});

test('Zugangssperre (403/429) ist kein toter Link', async () => {
  const fetchImpl = respond({ 'HEAD https://a.example/': 403, 'GET https://a.example/': 403 });
  assert.deepEqual(await checkUrl('https://a.example/', { fetchImpl, assertUrl: okHop }), { ok: true, code: 403, error: null });
});

test('Redirect wird verfolgt, Ziel zählt', async () => {
  const fetchImpl = respond({ 'https://a.example/': 301, 'https://b.example/': 200 });
  assert.equal((await checkUrl('https://a.example/', { fetchImpl, assertUrl: okHop })).ok, true);
});

test('Netzfehler → NETWORK, SSRF-Treffer → SSRF_BLOCKED (kein Request)', async () => {
  const net = await checkUrl('https://a.example/', { fetchImpl: respond({ 'https://a.example/': new Error('ECONNREFUSED') }), assertUrl: okHop });
  assert.deepEqual(net, { ok: false, code: null, error: 'NETWORK' });
  let called = false;
  const ssrf = await checkUrl('http://127.0.0.1/', {
    fetchImpl: async () => { called = true; return new Response(null); },
    assertUrl: async () => { const e = new Error('blocked'); e.code = 'SSRF_BLOCKED_IP'; throw e; },
  });
  assert.deepEqual(ssrf, { ok: false, code: null, error: 'SSRF_BLOCKED' });
  assert.equal(called, false);
});

test('ohne Seam greift der echte Guard: interne Adresse wird nicht abgefragt', async () => {
  const r = await checkUrl('http://127.0.0.1:1/', { fetchImpl: async () => { throw new Error('darf nicht laufen'); } });
  assert.equal(r.error, 'SSRF_BLOCKED');
});

test('DNS-Fehler → DNS, unlesbare URL → INVALID, nur die Sperre ist SSRF_BLOCKED', async () => {
  const fail = (code) => async () => { const e = new Error(code); e.code = code; throw e; };
  const fetchImpl = async () => { throw new Error('darf nicht laufen'); };
  assert.equal((await checkUrl('https://nx.example/', { fetchImpl, assertUrl: fail('SSRF_DNS_FAILED') })).error, 'DNS');
  assert.equal((await checkUrl('kaputt', { fetchImpl, assertUrl: fail('SSRF_INVALID_URL') })).error, 'INVALID');
  assert.equal((await checkUrl('http://10.0.0.1/', { fetchImpl, assertUrl: fail('SSRF_BLOCKED_HOST') })).error, 'SSRF_BLOCKED');
});

test('jeder Fehlercode hat einen Anzeigetext (recherche.linkCheck.err.<CODE>) in beiden Locales', () => {
  const de = require('../../public/js/i18n/de.json');
  const en = require('../../public/js/i18n/en.json');
  for (const code of ['SSRF_BLOCKED', 'DNS', 'INVALID', 'TIMEOUT', 'REDIRECT', 'NETWORK']) {
    assert.ok(de[`recherche.linkCheck.err.${code}`], `de: ${code}`);
    assert.ok(en[`recherche.linkCheck.err.${code}`], `en: ${code}`);
  }
});
