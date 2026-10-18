// Gate für die Werkstatt-Daten im Service Worker (public/sw-domain.js).
//
// DIE INVARIANTEN:
//   1. Netz zuerst: online sieht jede Karte den Serverstand, nie einen Cache-Hit.
//   2. Ohne Netz liefert der SW die letzte gute JSON-Antwort; ohne Eintrag
//      scheitert der Request wie ohne SW (Response.error).
//   3. Abgelegt wird nur eine 200er-JSON-Antwort — keine 401 (der globale
//      401-Wrapper muss sie sehen), keine Bilder/Dokumente/Audio.
//   4. Der Cache gehört zur Sitzung: Logout und Sitzungswechsel werfen ihn weg.
//   5. Die Weiche in sw.js leitet nur die Werkstatt-Pfade hierher, und zwar
//      exakt (kein `/ideenx`), Chat/Jobs/Suche bleiben unbehandelt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
const DOMAIN_SRC = fs.readFileSync(path.join(ROOT, 'public/sw-domain.js'), 'utf8');
const ORIGIN = 'https://example.test';
const DOMAIN_CACHE = 'schreibwerkstatt-domain-v1';
const JSON_CT = { 'Content-Type': 'application/json; charset=utf-8' };

class FakeHeaders {
  constructor(src) {
    this._h = new Map();
    if (src instanceof FakeHeaders) for (const [k, v] of src._h) this._h.set(k, v);
    else for (const [k, v] of Object.entries(src ?? {})) this._h.set(k.toLowerCase(), v);
  }
  set(k, v) { this._h.set(String(k).toLowerCase(), v); }
  get(k) { return this._h.get(String(k).toLowerCase()) ?? null; }
}

class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.type = init.type ?? 'basic';
    this.headers = new FakeHeaders(init.headers);
    this._h = this.headers._h;
  }
  static error() { return new FakeResponse(null, { status: 0, type: 'error' }); }
  get ok() { return this.status >= 200 && this.status < 300; }
  clone() { return new FakeResponse(this.body, { status: this.status, type: this.type, headers: Object.fromEntries(this._h) }); }
}

class FakeRequest {
  constructor(url, init = {}) {
    this.url = String(url).startsWith('http') ? String(url) : ORIGIN + url;
    this.method = init.method ?? 'GET';
    this.mode = init.mode ?? 'cors';
  }
}

function makeCaches() {
  const byName = new Map();
  const deleted = [];
  const norm = (r) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).href;
  const open = (name) => {
    if (!byName.has(name)) {
      const store = new Map();
      byName.set(name, {
        store,
        async match(r) { return store.get(norm(r)); },
        async put(r, res) { store.delete(norm(r)); store.set(norm(r), res); },
        async delete(r) { return store.delete(norm(r)); },
        async keys() { return [...store.keys()].map((u) => new FakeRequest(u)); },
      });
    }
    return byName.get(name);
  };
  return {
    byName, deleted,
    async open(name) { return open(name); },
    async delete(name) { deleted.push(name); return byName.delete(name); },
    async keys() { return [...byName.keys()]; },
    async match() { return undefined; },
  };
}

function loadSw({ fetchImpl }) {
  const caches = makeCaches();
  const timers = [];
  const listeners = {};
  const sandbox = {
    console, URL, JSON, AbortController,
    // Kurze Timer sofort; der Netz-Timeout von sw-domain.js (Sekunden) feuert
    // nur, wenn ein Test ihn ausdrücklich auslöst (`sw.fireNetTimeout()`).
    setTimeout: (fn, ms) => { if (ms >= 1000) { timers.push(fn); return timers.length; } fn(); return 0; },
    clearTimeout,
    Response: FakeResponse, Request: FakeRequest, Headers: FakeHeaders, caches, fetch: fetchImpl,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self.location = { origin: ORIGIN };
  sandbox.self.__SHELL_BUILD = 'testbuild';
  sandbox.self.__SHELL_MANIFEST = ['/js/app.js'];
  sandbox.self.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
  sandbox.self.clients = { matchAll: async () => [] };
  const ctx = vm.createContext(sandbox);
  sandbox.importScripts = (...urls) => { if (urls.includes('/sw-domain.js')) vm.runInContext(DOMAIN_SRC, ctx); };
  vm.runInContext(SW_SRC, ctx);
  return { ctx, caches, listeners, fireNetTimeout: () => { for (const fn of timers.splice(0)) fn(); } };
}

// Feuert das fetch-Event wie der Browser; liefert die Antwort oder null, wenn
// der SW den Request unbehandelt ans Netz lässt.
async function dispatchFetch(sw, url) {
  let responded = null;
  const waits = [];
  const event = {
    request: new FakeRequest(url),
    respondWith(p) { responded = p; },
    waitUntil(p) { waits.push(p); },
  };
  for (const fn of sw.listeners.fetch) fn(event);
  const res = responded ? await responded : null;
  await Promise.all(waits);
  return res;
}

const domainStore = (sw) => sw.caches.byName.get(DOMAIN_CACHE)?.store ?? new Map();

test('online gewinnt das Netz und die JSON-Antwort wird abgelegt', async () => {
  let n = 0;
  const sw = loadSw({ fetchImpl: async () => new FakeResponse(`{"v":${++n}}`, { headers: JSON_CT }) });
  assert.equal((await dispatchFetch(sw, '/figures/5')).body, '{"v":1}');
  assert.equal((await dispatchFetch(sw, '/figures/5')).body, '{"v":2}', 'zweiter Read: wieder Netz, kein Cache-Hit');
  assert.equal(domainStore(sw).get(`${ORIGIN}/figures/5`).body, '{"v":2}');
});

test('ohne Netz kommt die letzte gute Antwort, ohne Eintrag ein Netzfehler', async () => {
  let offline = false;
  const sw = loadSw({ fetchImpl: async () => {
    if (offline) throw new TypeError('Failed to fetch');
    return new FakeResponse('{"pages":[1]}', { headers: JSON_CT });
  } });
  await dispatchFetch(sw, '/book-editor/5/contents');
  offline = true;
  assert.equal((await dispatchFetch(sw, '/book-editor/5/contents')).body, '{"pages":[1]}');
  const miss = await dispatchFetch(sw, '/ideen/board?book_id=5');
  assert.equal(miss.type, 'error', 'Miss verhält sich wie ein Request ohne SW');
});

test('401 geht durch und wird nicht abgelegt; ein alter Eintrag beschönigt sie nicht', async () => {
  let status = 200;
  const sw = loadSw({ fetchImpl: async () => new FakeResponse('{}', { status, headers: JSON_CT }) });
  await dispatchFetch(sw, '/locations/5');
  status = 401;
  assert.equal((await dispatchFetch(sw, '/locations/5')).status, 401);
  assert.equal(domainStore(sw).get(`${ORIGIN}/locations/5`).status, 200, 'Eintrag bleibt der letzte gute Stand');
});

test('Bilder/Dokumente/Audio der Recherche und Suchanfragen behandelt der SW nicht', async () => {
  const sw = loadSw({ fetchImpl: async () => new FakeResponse('PNG', { headers: { 'Content-Type': 'image/png' } }) });
  for (const p of ['/research/9/image', '/research/9/doc', '/research/9/audio', '/history/rueckblick-search?q=x', '/figures?book_id=5&q=anna']) {
    assert.equal(await dispatchFetch(sw, p), null, p);
  }
  assert.equal(domainStore(sw).size, 0);
});

test('Antwort aus der Ablage trägt X-SW-Fallback, die Netzantwort nicht', async () => {
  let offline = false;
  const sw = loadSw({ fetchImpl: async () => {
    if (offline) throw new TypeError('Failed to fetch');
    return new FakeResponse('{"a":1}', { headers: JSON_CT });
  } });
  assert.equal((await dispatchFetch(sw, '/figures/5')).headers.get('X-SW-Fallback'), null);
  offline = true;
  const hit = await dispatchFetch(sw, '/figures/5');
  assert.equal(hit.body, '{"a":1}');
  assert.equal(hit.headers.get('X-SW-Fallback'), 'domain');
});

test('Hängendes Netz: nach dem Timeout kommt die Ablage, die späte Antwort füllt sie nach', async () => {
  let release = null;
  let hang = false;
  const sw = loadSw({ fetchImpl: () => (hang
    ? new Promise((r) => { release = () => r(new FakeResponse('{"v":2}', { headers: JSON_CT })); })
    : Promise.resolve(new FakeResponse('{"v":1}', { headers: JSON_CT }))) });
  await dispatchFetch(sw, '/locations/5');
  hang = true;
  const pending = dispatchFetch(sw, '/locations/5');
  await new Promise((r) => setImmediate(r));
  sw.fireNetTimeout();
  const res = await pending;
  assert.equal(res.body, '{"v":1}');
  assert.equal(res.headers.get('X-SW-Fallback'), 'domain');
  release();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(domainStore(sw).get(`${ORIGIN}/locations/5`).body, '{"v":2}');
});

test('Hängendes Netz ohne Eintrag: es wird weiter aufs Netz gewartet', async () => {
  let release = null;
  const sw = loadSw({ fetchImpl: () => new Promise((r) => { release = () => r(new FakeResponse('{"v":1}', { headers: JSON_CT })); }) });
  const pending = dispatchFetch(sw, '/locations/6');
  await new Promise((r) => setImmediate(r));
  sw.fireNetTimeout();
  release();
  assert.equal((await pending).body, '{"v":1}');
});

test('Volltexte des Bucheditors haben einen eigenen Deckel und werden nicht von Listen verdrängt', async () => {
  const sw = loadSw({ fetchImpl: async () => new FakeResponse('{}', { headers: JSON_CT }) });
  await dispatchFetch(sw, '/book-editor/1/contents');
  for (let i = 0; i < 160; i++) await dispatchFetch(sw, `/figures/${i}`);
  assert.ok(domainStore(sw).has(`${ORIGIN}/book-editor/1/contents`), 'Buch überlebt 160 Listen-Einträge');
  for (let b = 2; b <= 12; b++) await dispatchFetch(sw, `/book-editor/${b}/contents`);
  const books = [...domainStore(sw).keys()].filter((k) => k.includes('/book-editor/'));
  assert.equal(books.length, 8);
  assert.ok(!books.includes(`${ORIGIN}/book-editor/1/contents`), 'ältestes Buch fällt zuerst');
});

test('Weiche: nur die Werkstatt-Pfade, exakt; Chat/Jobs/Suche bleiben unbehandelt', async () => {
  const sw = loadSw({ fetchImpl: async () => new FakeResponse('{}', { headers: JSON_CT }) });
  for (const p of ['/figures/5', '/locations/5', '/ideen?book_id=5', '/research/tags?book_id=5',
    '/book-editor/5/contents', '/history/page/7', '/booksettings/5']) {
    assert.ok(await dispatchFetch(sw, p), `${p} muss behandelt werden`);
  }
  for (const p of ['/ideenx/1', '/chat/sessions', '/jobs/active', '/search?q=x']) {
    assert.equal(await dispatchFetch(sw, p), null, `${p} darf nicht behandelt werden`);
  }
});

test('Logout und Sitzungswechsel werfen den Cache weg; activate behält ihn', async () => {
  const sw = loadSw({ fetchImpl: async () => new FakeResponse('{}', { headers: JSON_CT }) });
  assert.ok(vm.runInContext(`ACTIVE_CACHES.has('${DOMAIN_CACHE}')`, sw.ctx), 'sonst räumt activate ihn bei jedem Deploy');
  for (const type of ['auth-logout', 'session-changed']) {
    await dispatchFetch(sw, '/figures/5');
    const waits = [];
    for (const fn of sw.listeners.message) fn({ data: { type }, waitUntil: (p) => waits.push(p), source: null });
    await Promise.all(waits);
    assert.ok(sw.caches.deleted.includes(DOMAIN_CACHE), type);
    assert.equal(sw.caches.byName.has(DOMAIN_CACHE), false, type);
    sw.caches.deleted.length = 0;
  }
});
