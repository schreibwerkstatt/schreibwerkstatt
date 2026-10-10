// Gate für „Buch offline halten" im Service Worker (public/sw-offline.js +
// Andockstellen in public/sw.js).
//
// WARUM ALS UNIT-TEST: Der SW ist auf localhost aus. Ob ein angeheftetes Buch
// im Zug wirklich vollständig lesbar ist, zeigt sich sonst erst offline auf
// HTTPS — als „dieser Abschnitt lädt nicht", lange nach dem Anheften.
//
// DIE INVARIANTEN:
//   1. Der Sync legt Buchliste, Buch, Baum und JEDEN Abschnitt ab.
//   2. Ein zweiter Sync lädt nur geänderte/fehlende Abschnitte und räumt
//      Abschnitte, die nicht mehr im Baum stehen.
//   3. Nach einem CONTENT_CACHE-Miss liefert sw.js die Offline-Kopie.
//   4. Ein Write lädt angeheftete Pfade nach, statt sie zu löschen.
//   5. Ein Sitzungswechsel wirft die Offline-Kopie mit weg.
//   6. 403/404 beim Baum meldet 'offline-book-failed' mit Status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
const OFFLINE_SRC = fs.readFileSync(path.join(ROOT, 'public/sw-offline.js'), 'utf8');
const ORIGIN = 'https://example.test';

class FakeResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.type = 'basic';
    this._h = new Map(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    this.headers = { get: (k) => this._h.get(String(k).toLowerCase()) ?? null };
  }
  get ok() { return this.status >= 200 && this.status < 300; }
  clone() { return new FakeResponse(this.body, { status: this.status, headers: Object.fromEntries(this._h) }); }
  async json() { return JSON.parse(this.body); }
  async text() { return String(this.body); }
}

class FakeRequest {
  constructor(url) { this.url = String(url).startsWith('http') ? String(url) : ORIGIN + url; this.method = 'GET'; this.mode = 'cors'; }
}

// Caches nach Namen, Schlüssel = volle URL.
function makeCaches() {
  const byName = new Map();
  const norm = (r) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).href;
  const open = (name) => {
    if (!byName.has(name)) {
      const store = new Map();
      byName.set(name, {
        store,
        async match(r) { return store.get(norm(r)); },
        async put(r, res) { store.set(norm(r), res); },
        async delete(r) { return store.delete(norm(r)); },
        async keys() { return [...store.keys()].map((u) => new FakeRequest(u)); },
      });
    }
    return byName.get(name);
  };
  return {
    byName,
    async open(name) { return open(name); },
    async keys() { return [...byName.keys()]; },
    async delete(name) { return byName.delete(name); },
    async match() { return undefined; },
    paths(name) { return [...(byName.get(name)?.store.keys() || [])].map((u) => new URL(u).pathname).sort(); },
  };
}

function load({ caches, server, posted = [] }) {
  const listeners = {};
  const fetched = [];
  const sandbox = {
    console, URL, AbortController, JSON, Promise,
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout,
    Response: FakeResponse, Request: FakeRequest, caches,
    fetch: async (req) => {
      const p = new URL(req.url).pathname + new URL(req.url).search;
      fetched.push(p);
      if (server.offline) throw new TypeError('Failed to fetch');
      const hit = server.routes[new URL(req.url).pathname];
      if (hit === undefined) return new FakeResponse('{}', { status: 404 });
      if (typeof hit === 'number') return new FakeResponse('{}', { status: hit });
      return new FakeResponse(typeof hit === 'string' ? hit : JSON.stringify(hit));
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self.location = { origin: ORIGIN };
  sandbox.self.__SHELL_BUILD = 'testbuild';
  sandbox.self.__SHELL_MANIFEST = ['/js/app.js'];
  sandbox.self.addEventListener = (type, fn) => { listeners[type] = fn; };
  sandbox.self.clients = { matchAll: async () => [{ postMessage: (m) => posted.push(m) }] };
  const ctx = vm.createContext(sandbox);
  sandbox.importScripts = (...urls) => {
    if (urls.includes('/sw-offline.js')) vm.runInContext(OFFLINE_SRC, ctx);
  };
  vm.runInContext(SW_SRC, ctx);
  ctx.__listeners = listeners;
  ctx.__fetched = fetched;
  return ctx;
}

const tree = (pages) => ({
  topPages: [pages[0]],
  chapters: [{ id: 1, pages: [pages[1]], subchapters: [{ id: 2, pages: pages.slice(2), subchapters: [] }] }],
});

function serverFor(pages) {
  const routes = {
    '/content/books': [{ id: 5, name: 'Buch' }],
    '/content/books/5': { id: 5 },
    '/content/books/5/tree': tree(pages),
  };
  for (const p of pages) routes[`/content/pages/${p.id}`] = { id: p.id, html: `<p>${p.updated_at}</p>` };
  return { routes, offline: false };
}

const OFF = 'schreibwerkstatt-offline-v1';

test('Sync legt Buchliste, Buch, Baum und jeden Abschnitt ab (auch verschachtelte Kapitel)', async () => {
  const caches = makeCaches();
  const pages = [{ id: 10, updated_at: 'a' }, { id: 11, updated_at: 'a' }, { id: 12, updated_at: 'a' }, { id: 13, updated_at: 'a' }];
  const posted = [];
  const ctx = load({ caches, server: serverFor(pages), posted });

  const entry = await ctx.__swOffline._syncBook(5);

  assert.equal(entry.total, 4);
  assert.deepEqual(caches.paths(OFF), [
    '/__offline-books', '/content/books', '/content/books/5', '/content/books/5/tree',
    '/content/pages/10', '/content/pages/11', '/content/pages/12', '/content/pages/13',
  ]);
  const done = posted.find((m) => m.type === 'offline-book-synced');
  assert.equal(done.bookId, 5);
  assert.equal(done.total, 4);
});

test('Zweiter Sync lädt nur Geändertes und räumt Verschwundenes', async () => {
  const caches = makeCaches();
  const pages = [{ id: 10, updated_at: 'a' }, { id: 11, updated_at: 'a' }, { id: 12, updated_at: 'a' }];
  const server = serverFor(pages);
  const ctx = load({ caches, server });
  await ctx.__swOffline._syncBook(5);

  // 11 geändert, 12 gelöscht, 14 neu.
  const next = [{ id: 10, updated_at: 'a' }, { id: 11, updated_at: 'b' }, { id: 14, updated_at: 'a' }];
  Object.assign(server, serverFor(next));
  ctx.__fetched.length = 0;
  await ctx.__swOffline._syncBook(5);

  const pageFetches = ctx.__fetched.filter((p) => p.startsWith('/content/pages/')).sort();
  assert.deepEqual(pageFetches, ['/content/pages/11', '/content/pages/14'],
    'Unveränderte Abschnitte gehen nicht übers Netz.');
  assert.ok(!caches.paths(OFF).includes('/content/pages/12'), 'Gelöschter Abschnitt wird geräumt.');
});

test('Nach einem CONTENT_CACHE-Miss liefert sw.js die Offline-Kopie', async () => {
  const caches = makeCaches();
  const pages = [{ id: 10, updated_at: 'a' }, { id: 11, updated_at: 'a' }];
  const server = serverFor(pages);
  const ctx = load({ caches, server });
  await ctx.__swOffline._syncBook(5);

  server.offline = true;
  const res = await ctx.handleContent(new FakeRequest('/content/pages/11'));
  assert.equal(res.status, 200);
  assert.match(res.body, /"id":11/);
});

test('Revalidierung eines angehefteten Pfads frischt die Offline-Kopie auf', async () => {
  const caches = makeCaches();
  const pages = [{ id: 10, updated_at: 'a' }, { id: 11, updated_at: 'a' }];
  const server = serverFor(pages);
  const ctx = load({ caches, server });
  await ctx.__swOffline._syncBook(5);

  server.routes['/content/pages/11'] = { id: 11, html: '<p>neu</p>' };
  // CONTENT_CACHE-Treffer liegt vor → SWR revalidiert im Hintergrund.
  await (await caches.open('schreibwerkstatt-content-v1')).put('/content/pages/11', new FakeResponse('{"id":11,"html":"alt"}'));
  await ctx.handleContent(new FakeRequest('/content/pages/11'));
  await new Promise((r) => setImmediate(r));
  const copy = await (await caches.open(OFF)).match(ORIGIN + '/content/pages/11');
  assert.match(copy.body, /neu/);
});

test('invalidate-content lädt angeheftete Pfade nach statt sie zu löschen', async () => {
  const caches = makeCaches();
  const pages = [{ id: 10, updated_at: 'a' }, { id: 11, updated_at: 'a' }];
  const server = serverFor(pages);
  const ctx = load({ caches, server });
  await ctx.__swOffline._syncBook(5);

  server.routes['/content/pages/10'] = { id: 10, html: '<p>gespeichert</p>' };
  let waited;
  ctx.__listeners.message({ data: { type: 'invalidate-content', paths: ['pages/10'] }, waitUntil: (p) => { waited = p; } });
  await waited;
  const copy = await (await caches.open(OFF)).match(ORIGIN + '/content/pages/10');
  assert.ok(copy, 'Die Offline-Kopie bleibt bestehen.');
  assert.match(copy.body, /gespeichert/);
});

test('Sitzungswechsel wirft die Offline-Kopie mit weg', async () => {
  const caches = makeCaches();
  const ctx = load({ caches, server: serverFor([{ id: 10, updated_at: 'a' }, { id: 11, updated_at: 'a' }]) });
  await ctx.__swOffline._syncBook(5);
  assert.ok(caches.byName.has(OFF));

  let waited;
  ctx.__listeners.message({ data: { type: 'session-changed' }, waitUntil: (p) => { waited = p; }, source: { postMessage() {} } });
  await waited;
  assert.ok(!caches.byName.has(OFF));
});

test('Baum mit 403 meldet offline-book-failed samt Status', async () => {
  const caches = makeCaches();
  const posted = [];
  const server = serverFor([{ id: 10, updated_at: 'a' }, { id: 11, updated_at: 'a' }]);
  server.routes['/content/books/5/tree'] = 403;
  const ctx = load({ caches, server, posted });
  await ctx.__swOffline._syncBook(5);
  const failed = posted.find((m) => m.type === 'offline-book-failed');
  assert.equal(failed.status, 403);
});

test('Entfernen räumt die Abschnitte des Buchs', async () => {
  const caches = makeCaches();
  const ctx = load({ caches, server: serverFor([{ id: 10, updated_at: 'a' }, { id: 11, updated_at: 'a' }]) });
  await ctx.__swOffline._syncBook(5);
  let waited;
  ctx.__listeners.message({ data: { type: 'offline-book-remove', bookId: 5 }, waitUntil: (p) => { waited = p; }, source: { postMessage() {} } });
  await waited;
  assert.deepEqual(caches.paths(OFF), ['/__offline-books']);
});
