// Unit-Tests fuer lib/http-util.js (Timeout-Fetch, Byte-Deckel, Sleep, Retry)
// und lib/ssrf-guard.js#safeFetch (Guard pro Hop, Redirect-Deckel, Timeout).
//
// Lauf: `node --test tests/unit/http-util.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.SSRF_SKIP_DNS_CHECK = '1';
const { fetchWithTimeout, readCapped, sleep, withRetry } = require('../../lib/http-util.js');
const { safeFetch } = require('../../lib/ssrf-guard.js');

const hangingFetch = (_url, opts) => new Promise((_, reject) => {
  opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true });
});

test('fetchWithTimeout: Timeout wirft AbortError mit Code', async () => {
  await assert.rejects(
    fetchWithTimeout('https://x.test/', {}, 20, { fetchImpl: hangingFetch, timeoutCode: 'MY_TIMEOUT' }),
    (e) => e.name === 'AbortError' && e.code === 'MY_TIMEOUT');
});

test('fetchWithTimeout: Aufrufer-Abbruch bleibt Aufrufer-Abbruch', async () => {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 5);
  await assert.rejects(
    fetchWithTimeout('https://x.test/', { signal: ctrl.signal }, 5000, { fetchImpl: hangingFetch }),
    (e) => e.name === 'AbortError' && e.code !== 'FETCH_TIMEOUT');
});

test('readCapped: Stream, getReader und arrayBuffer werden gedeckelt', async () => {
  const big = Buffer.alloc(100, 1);
  const iter = { headers: { get: () => null }, body: { async *[Symbol.asyncIterator]() { yield big; yield big; } } };
  await assert.rejects(readCapped(iter, 150, { tooLargeCode: 'X' }), (e) => e.code === 'X');
  const web = { headers: { get: () => null }, body: new Blob([big, big]).stream() };
  delete web.body[Symbol.asyncIterator];
  await assert.rejects(readCapped({ headers: web.headers, body: { getReader: () => web.body.getReader() } }, 150), (e) => e.code === 'RESPONSE_TOO_LARGE');
  const ab = { headers: { get: () => '10' }, arrayBuffer: async () => new ArrayBuffer(10) };
  assert.equal((await readCapped(ab, 50)).length, 10);
  const declared = { headers: { get: () => '9999' }, arrayBuffer: async () => { throw new Error('darf nicht lesen'); } };
  await assert.rejects(readCapped(declared, 50), (e) => e.code === 'RESPONSE_TOO_LARGE');
});

test('sleep: Abbruch rejected sofort', async () => {
  const ctrl = new AbortController();
  const p = sleep(10_000, ctrl.signal);
  ctrl.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
});

test('withRetry: retriable wiederholt, nicht-retriable sofort', async () => {
  let n = 0;
  const out = await withRetry(async () => {
    if (++n < 3) { const e = new Error('blip'); e.retriable = true; throw e; }
    return 'ok';
  }, { retries: 3, baseMs: 1 });
  assert.equal(out, 'ok');
  assert.equal(n, 3);
  let m = 0;
  await assert.rejects(withRetry(async () => { m++; throw new Error('400'); }, { retries: 3, baseMs: 1 }));
  assert.equal(m, 1);
});

function redirect(loc) { return { ok: false, status: 302, headers: { get: (k) => (k === 'location' ? loc : null) } }; }
function ok(buf = Buffer.from('hi')) {
  return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => buf };
}

test('safeFetch: Redirect auf mapped-IPv6-loopback wird am zweiten Hop gestoppt', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return calls.length === 1 ? redirect('http://[::ffff:127.0.0.1]:3737/admin') : ok();
  };
  await assert.rejects(safeFetch('https://pub.test/a', { fetchImpl }), (e) => e.code === 'SSRF_BLOCKED_HOST');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.redirect, 'manual');
});

test('safeFetch: Redirect-Deckel, relative Location, finale URL', async () => {
  let n = 0;
  const loop = async () => redirect(`/hop${++n}`);
  await assert.rejects(safeFetch('https://pub.test/a', { fetchImpl: loop, maxRedirects: 2 }),
    (e) => e.code === 'FETCH_REDIRECT_LIMIT' && e.status === 302);
  assert.equal(n, 3);
  let k = 0;
  const once = async () => (++k === 1 ? redirect('/b') : ok());
  const out = await safeFetch('https://pub.test/a', { fetchImpl: once });
  assert.equal(out.url, 'https://pub.test/b');
  assert.equal(out.buffer.toString(), 'hi');
});

test('safeFetch: Timeout greift mit eigenem Code, nicht-OK wird zurueckgegeben', async () => {
  await assert.rejects(safeFetch('https://pub.test/', { fetchImpl: hangingFetch, timeoutMs: 20, timeoutCode: 'T' }),
    (e) => e.code === 'T');
  const out = await safeFetch('https://pub.test/', { fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null } }) });
  assert.equal(out.response.status, 404);
  assert.equal(out.buffer, null);
});

test('safeFetch: accept() darf vor dem Lesen abbrechen', async () => {
  let read = false;
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => 'application/pdf' }, arrayBuffer: async () => { read = true; return new ArrayBuffer(1); } });
  await assert.rejects(safeFetch('https://pub.test/', {
    fetchImpl, accept: () => { const e = new Error('nope'); e.code = 'NOT_HTML'; throw e; },
  }), (e) => e.code === 'NOT_HTML');
  assert.equal(read, false);
});

test('resolveByteRange: Einzelbereich, Suffix, offenes Ende, Deckel', () => {
  const { resolveByteRange } = require('../../lib/http-util');
  assert.equal(resolveByteRange(undefined, 100), null);
  assert.equal(resolveByteRange('items=0-1', 100), null);
  assert.deepEqual(resolveByteRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepEqual(resolveByteRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(resolveByteRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepEqual(resolveByteRange('bytes=0-500', 100), { start: 0, end: 99 });
  assert.deepEqual(resolveByteRange('bytes=-', 100), { unsatisfiable: true });
  assert.deepEqual(resolveByteRange('bytes=100-', 100), { unsatisfiable: true });
  assert.deepEqual(resolveByteRange('bytes=5-2', 100), { unsatisfiable: true });
  // `<audio>` fragt `bytes=0-` an — gedeckelt, nicht die ganze Datei.
  assert.deepEqual(resolveByteRange('bytes=0-', 100, 16), { start: 0, end: 15 });
  assert.deepEqual(resolveByteRange('bytes=-50', 100, 16), { start: 50, end: 65 });
});
