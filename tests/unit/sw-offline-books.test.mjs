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
//   7. Ein frischer Baum mit neuen Stempeln stösst den Sync von selbst an
//      (gedrosselt; gescheiterte Abschnitte mit gleichem Stempel zählen nicht).
//   8. Die Werkstatt-Listen eines angehefteten Buchs liegen mit in der Kopie,
//      sw-domain.js liefert sie offline, Entfernen räumt sie.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
const OFFLINE_SRC = fs.readFileSync(path.join(ROOT, 'public/sw-offline.js'), 'utf8');
const DOMAIN_SRC = fs.readFileSync(path.join(ROOT, 'public/sw-domain.js'), 'utf8');
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
    if (urls.includes('/sw-domain.js')) vm.runInContext(DOMAIN_SRC, ctx);
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

// --- Mehrere Bücher, Entfernen während des Syncs ------------------------------

function twoBookServer() {
  const routes = { '/content/books': [{ id: 5 }, { id: 6 }] };
  for (const [book, ids] of [[5, [10, 11, 12]], [6, [20, 21, 22]]]) {
    const pages = ids.map((id) => ({ id, updated_at: 'a' }));
    routes[`/content/books/${book}`] = { id: book };
    routes[`/content/books/${book}/tree`] = tree(pages);
    for (const p of pages) routes[`/content/pages/${p.id}`] = { id: p.id, html: '<p>x</p>' };
  }
  return { routes, offline: false };
}

async function statusOf(ctx) {
  let books;
  ctx.__listeners.message({
    data: { type: 'offline-book-status' },
    waitUntil: async (p) => { await p; },
    source: { postMessage: (m) => { books = m.books; } },
  });
  await new Promise((r) => setImmediate(r));
  return books;
}

test('Paralleler Sync zweier Bücher: keiner überschreibt den Meta-Eintrag des anderen', async () => {
  // Der Client stösst beim Start alle angehefteten Bücher auf einmal an.
  const caches = makeCaches();
  const ctx = load({ caches, server: twoBookServer() });

  await Promise.all([ctx.__swOffline._syncBook(5), ctx.__swOffline._syncBook(6)]);

  const books = await statusOf(ctx);
  assert.deepEqual(Object.keys(books).sort(), ['5', '6']);
  assert.equal(books['5'].total, 3);
  assert.equal(books['6'].total, 3);
});

test('Entfernen während eines laufenden Syncs: das Buch kommt nicht zurück', async () => {
  const caches = makeCaches();
  const ctx = load({ caches, server: twoBookServer() });

  const sync = ctx.__swOffline._syncBook(5);
  await ctx.__swOffline._removeBook(5);
  await sync;

  assert.deepEqual(Object.keys(await statusOf(ctx)), []);
  assert.ok(!caches.paths(OFF).some((p) => /^\/content\/(?:pages\/1\d|books\/5)/.test(p)),
    'keine Abschnitte des entfernten Buchs bleiben liegen');
});

// --- Bilder --------------------------------------------------------------------

const IMG = 'schreibwerkstatt-images-v1';

function imageServer() {
  const server = twoBookServer();
  server.routes['/content/pages/10'] = { id: 10, html: '<img src="/content/page-image/7"><img src="/content/page-image/8">' };
  server.routes['/content/pages/20'] = { id: 20, html: '<img src="/content/page-image/7">' };
  server.routes['/content/page-image/7'] = 'BILD7';
  server.routes['/content/page-image/8'] = 'BILD8';
  return server;
}

test('Sync legt die Bilder eines Abschnitts im Offline-Cache ab', async () => {
  const caches = makeCaches();
  const ctx = load({ caches, server: imageServer() });

  await ctx.__swOffline._syncBook(5);

  const paths = caches.paths(OFF);
  assert.ok(paths.includes('/content/page-image/7') && paths.includes('/content/page-image/8'));
});

test('Ein Bild mit HTTP-Fehler lässt den Abschnitt nicht scheitern', async () => {
  const caches = makeCaches();
  const server = imageServer();
  server.routes['/content/page-image/8'] = 404;
  const ctx = load({ caches, server });

  const entry = await ctx.__swOffline._syncBook(5);

  assert.equal(entry.failed, 0);
  assert.ok(caches.paths(OFF).includes('/content/page-image/7'));
});

test('Abschnitt ohne gemerkte Bild-Liste (Altbestand) wird einmal neu geladen', async () => {
  const caches = makeCaches();
  const server = imageServer();
  const ctx = load({ caches, server });
  await ctx.__swOffline._syncBook(5);
  // Meta wie vor den Bildern: ohne pageImages.
  const off = await caches.open(OFF);
  const meta = await (await off.match(ORIGIN + '/__offline-books')).json();
  delete meta.books['5'].pageImages;
  await off.put(ORIGIN + '/__offline-books', new FakeResponse(JSON.stringify(meta)));

  ctx.__fetched.length = 0;
  await ctx.__swOffline._syncBook(5);
  assert.ok(ctx.__fetched.includes('/content/pages/10'));

  ctx.__fetched.length = 0;
  await ctx.__swOffline._syncBook(5);
  assert.deepEqual(ctx.__fetched.filter((p) => p.startsWith('/content/pages/')), [],
    'danach wieder inkrementell');
});

test('Entfernen räumt Bilder nur, wenn kein anderes angeheftetes Buch sie nutzt', async () => {
  const caches = makeCaches();
  const ctx = load({ caches, server: imageServer() });
  await ctx.__swOffline._syncBook(5);
  await ctx.__swOffline._syncBook(6);

  await ctx.__swOffline._removeBook(5);
  let paths = caches.paths(OFF);
  assert.ok(paths.includes('/content/page-image/7'), 'Buch 6 nutzt Bild 7 noch');
  assert.ok(!paths.includes('/content/page-image/8'), 'Bild 8 gehörte nur Buch 5');

  await ctx.__swOffline._removeBook(6);
  paths = caches.paths(OFF);
  assert.ok(!paths.includes('/content/page-image/7'));
});

test('Bild-Requests laufen am CONTENT_CACHE vorbei in den eigenen, gedeckelten Cache', async () => {
  const caches = makeCaches();
  const server = imageServer();
  const ctx = load({ caches, server });
  const respond = async (p) => {
    let res;
    const pending = [];
    ctx.__listeners.fetch({
      request: new FakeRequest(p),
      respondWith: (r) => { res = r; },
      waitUntil: (w) => pending.push(w),
    });
    const out = await res;
    await Promise.all(pending);
    return out;
  };

  assert.equal((await respond('/content/page-image/7')).body, 'BILD7');
  assert.ok(!caches.byName.has('schreibwerkstatt-content-v1')
    || !caches.paths('schreibwerkstatt-content-v1').length, 'nicht im CONTENT_CACHE');
  assert.deepEqual(caches.paths(IMG), ['/content/page-image/7']);

  ctx.__fetched.length = 0;
  assert.equal((await respond('/content/page-image/7')).body, 'BILD7');
  assert.deepEqual(ctx.__fetched, [], 'zweiter Abruf aus dem Cache — Bild-Bytes einer ID ändern sich nie');

  server.routes['/content/page-image/9'] = 401;
  await respond('/content/page-image/9');
  assert.ok(!caches.paths(IMG).includes('/content/page-image/9'), '401 wird nicht abgelegt');
});

test('Sitzungswechsel wirft auch den Bild-Cache weg', async () => {
  const caches = makeCaches();
  const ctx = load({ caches, server: imageServer() });
  await ctx.__swOffline.respondImage(new FakeRequest('/content/page-image/7'), null);
  await new Promise((r) => setImmediate(r));
  assert.ok(caches.byName.has(IMG));

  let waited;
  ctx.__listeners.message({ data: { type: 'session-changed' }, waitUntil: (p) => { waited = p; }, source: { postMessage() {} } });
  await waited;
  assert.ok(!caches.byName.has(IMG));
});

// --- Nachzug bei frischem Baum -------------------------------------------------

const treeRes = (pages) => new FakeResponse(JSON.stringify(tree(pages)));
const pageFetches = (ctx) => ctx.__fetched.filter((p) => p.startsWith('/content/pages/')).sort();

test('Ein frischer Baum mit neuen Stempeln stösst den Sync an, ein unveränderter nicht', async () => {
  const caches = makeCaches();
  const pages = [{ id: 10, updated_at: 'a' }, { id: 11, updated_at: 'a' }, { id: 12, updated_at: 'a' }];
  const server = serverFor(pages);
  const ctx = load({ caches, server });
  await ctx.__swOffline._syncBook(5);

  ctx.__fetched.length = 0;
  await ctx.__swOffline.refresh(new FakeRequest('/content/books/5/tree?__fresh=1'), treeRes(pages));
  assert.deepEqual(ctx.__fetched, [], 'unveränderter Baum: kein Sync');

  // Ein anderes Gerät hat Abschnitt 11 geändert.
  const next = [{ id: 10, updated_at: 'a' }, { id: 11, updated_at: 'b' }, { id: 12, updated_at: 'a' }];
  Object.assign(server, serverFor(next));
  await ctx.__swOffline.refresh(new FakeRequest('/content/books/5/tree'), treeRes(next));
  assert.deepEqual(pageFetches(ctx), ['/content/pages/11']);
  const copy = await (await caches.open(OFF)).match(ORIGIN + '/content/pages/11');
  assert.match(copy.body, /<p>b<\/p>/);
});

test('Auto-Sync ist je Buch gedrosselt', async () => {
  const caches = makeCaches();
  const server = serverFor([{ id: 10, updated_at: 'a' }, { id: 11, updated_at: 'a' }]);
  const ctx = load({ caches, server });
  await ctx.__swOffline._syncBook(5);

  const b = [{ id: 10, updated_at: 'b' }, { id: 11, updated_at: 'a' }];
  Object.assign(server, serverFor(b));
  await ctx.__swOffline.refresh(new FakeRequest('/content/books/5/tree'), treeRes(b));
  const c = [{ id: 10, updated_at: 'c' }, { id: 11, updated_at: 'a' }];
  Object.assign(server, serverFor(c));
  ctx.__fetched.length = 0;
  await ctx.__swOffline.refresh(new FakeRequest('/content/books/5/tree'), treeRes(c));
  assert.deepEqual(pageFetches(ctx), [], 'innerhalb der Sperrfrist kein zweiter Sync');

  ctx.__swOffline._resetAutoSync();
  await ctx.__swOffline.refresh(new FakeRequest('/content/books/5/tree'), treeRes(c));
  assert.deepEqual(pageFetches(ctx), ['/content/pages/10']);
});

test('Gescheiterter Abschnitt mit unverändertem Stempel löst keinen Auto-Sync aus', async () => {
  const caches = makeCaches();
  const pages = [{ id: 10, updated_at: 'a' }, { id: 11, updated_at: 'a' }];
  const server = serverFor(pages);
  server.routes['/content/pages/11'] = 404;
  const ctx = load({ caches, server });
  const entry = await ctx.__swOffline._syncBook(5);
  assert.equal(entry.failed, 1);

  ctx.__fetched.length = 0;
  await ctx.__swOffline.refresh(new FakeRequest('/content/books/5/tree'), treeRes(pages));
  assert.deepEqual(ctx.__fetched, []);
});

test('Ein nicht angehefteter Baum stösst nichts an', async () => {
  const caches = makeCaches();
  const ctx = load({ caches, server: serverFor([{ id: 10, updated_at: 'a' }, { id: 11, updated_at: 'a' }]) });
  await ctx.__swOffline.refresh(new FakeRequest('/content/books/5/tree'), treeRes([{ id: 10, updated_at: 'b' }, { id: 11, updated_at: 'a' }]));
  assert.deepEqual(ctx.__fetched, []);
  assert.ok(!caches.paths(OFF).includes('/content/books/5/tree'));
});

// --- Werkstatt-Listen ----------------------------------------------------------

test('Werkstatt-Listen liegen in der Kopie, sw-domain liefert sie offline, Entfernen räumt sie', async () => {
  const caches = makeCaches();
  const server = serverFor([{ id: 10, updated_at: 'a' }, { id: 11, updated_at: 'a' }]);
  server.routes['/figures/5'] = { figuren: [{ id: 'f1' }] };
  server.routes['/ideen/board'] = { ideen: [{ id: 3 }] };
  server.routes['/booksettings/5'] = 403; // ohne Zugriff: bleibt aus, Sync geht trotzdem durch
  const ctx = load({ caches, server });
  const entry = await ctx.__swOffline._syncBook(5);
  assert.equal(entry.failed, 0);
  assert.ok(caches.paths(OFF).includes('/figures/5'));
  assert.ok(!caches.paths(OFF).includes('/booksettings/5'));
  const key = [...caches.byName.get(OFF).store.keys()].find((u) => u.includes('/ideen/board'));
  assert.equal(key, ORIGIN + '/ideen/board?book_id=5', 'abgelegt unter der exakten Karten-URL');

  server.offline = true;
  const res = await ctx.__swDomain.respond(new FakeRequest('/ideen/board?book_id=5'), null);
  assert.equal(res.status, 200);
  assert.match(res.body, /"id":3/);

  ctx.__fetched.length = 0;
  server.offline = false;
  await ctx.__swOffline._syncBook(5);
  assert.ok(!ctx.__fetched.includes('/figures/5'), 'Listen werden höchstens alle zehn Minuten nachgeladen');

  await ctx.__swOffline._removeBook(5);
  assert.deepEqual(caches.paths(OFF), ['/__offline-books']);
});

test('refreshDomain ersetzt nur Kopien angehefteter Bücher', async () => {
  const caches = makeCaches();
  const server = serverFor([{ id: 10, updated_at: 'a' }, { id: 11, updated_at: 'a' }]);
  server.routes['/figures/5'] = { figuren: [] };
  const ctx = load({ caches, server });
  await ctx.__swOffline._syncBook(5);

  await ctx.__swOffline.refreshDomain(new FakeRequest('/figures/5'), new FakeResponse('{"figuren":[{"id":"neu"}]}'));
  await ctx.__swOffline.refreshDomain(new FakeRequest('/figures/6'), new FakeResponse('{"figuren":[]}'));
  const copy = await ctx.__swOffline.matchDomain(new FakeRequest('/figures/5'));
  assert.match(copy.body, /neu/);
  assert.ok(!caches.paths(OFF).includes('/figures/6'));
});
