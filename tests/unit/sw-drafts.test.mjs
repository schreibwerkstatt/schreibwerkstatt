// Background Sync der Entwürfe im Service Worker (public/sw-drafts.js).
//
// DIE INVARIANTEN:
//   1. Die eigenen Save-Kennungen gehen als nackte Kennungen mit — nur die auf
//      der Basis des Entwurfs (der Server verwirft Objekte still, dann hielte
//      er den eigenen Save mit verlorener Antwort für fremd → 409).
//   2. Nur Fenster der App-Shell werden gefragt, welche Abschnitte sie halten;
//      ein Share-Reader- oder Login-Tab blockiert den Sync nicht.
//   3. 5xx/429 lassen den Lauf scheitern (der Browser wiederholt), 409 lässt
//      den Entwurf liegen, 401 beendet still.
//   4. Gesendet → Entwurf fällt (nur derselbe Stand), Vermerk `sent:<key>`,
//      Lösch-Broadcast mit dem gesendeten Stand, Meldung an die Tabs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'public/sw-drafts.js'), 'utf8');
const ORIGIN = 'https://example.test';
const KEY = (id) => `editor_draft_u:a@x:${id}`;

// Minimal-IndexedDB: ein Store, Requests und Transaktionen asynchron.
function fakeIndexedDb(initial = []) {
  const data = new Map(initial);
  const later = (fn) => setTimeout(fn, 0);
  function transaction() {
    let pending = 0;
    const tx = { oncomplete: null, onerror: null };
    const done = () => { if (--pending === 0) later(() => tx.oncomplete?.()); };
    const request = (fn) => {
      pending++;
      const r = { onsuccess: null, result: undefined };
      later(() => { r.result = fn(); r.onsuccess?.(); done(); });
      return r;
    };
    tx.objectStore = () => ({
      getAllKeys: () => request(() => [...data.keys()]),
      get: (k) => request(() => structuredClone(data.get(k))),
      put: (v, k) => request(() => { data.set(k, structuredClone(v)); }),
      delete: (k) => request(() => { data.delete(k); }),
    });
    return tx;
  }
  return {
    data,
    open() {
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null };
      req.result = { objectStoreNames: { contains: () => true }, transaction, close() {} };
      later(() => req.onsuccess?.());
      return req;
    },
  };
}

function load({ drafts, fetchImpl, windows = [{ url: ORIGIN + '/', held: [] }] }) {
  const idb = fakeIndexedDb(drafts);
  const posted = [];
  const notified = [];
  class FakeChannel { constructor() {} postMessage(m) { posted.push(m); } }
  class FakeMessageChannel {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { reply: (data) => this.port1.onmessage?.({ data }) };
    }
  }
  const sandbox = {
    console, URL, JSON, Date, Promise, Set, Map, Array, Number, structuredClone,
    setTimeout, clearTimeout,
    indexedDB: idb,
    BroadcastChannel: FakeChannel,
    MessageChannel: FakeMessageChannel,
    fetch: fetchImpl,
    CONTENT_CACHE: 'c',
    _invalidateCacheEntries: async () => {},
    notifyContentUpdated: async (p) => { notified.push(p); },
    navigator: {},
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
  };
  sandbox.self = sandbox;
  sandbox.self.addEventListener = () => {};
  sandbox.self.clients = {
    matchAll: async () => windows.map((w) => ({
      url: w.url,
      postMessage: (msg, [port]) => { if (w.held) port.reply({ held: w.held }); },
    })),
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { flush: () => sandbox.self.__swDrafts.flush(), idb, posted, notified };
}

const draft = (over = {}) => ({
  html: '<p>neu</p>', originalHtml: '<p>alt</p>', originalUpdatedAt: 'T0', savedAt: 100,
  owner: 'a@x', writer: 'notebook', ...over,
});

const configOk = { ok: true, status: 200, json: async () => ({ user: { email: 'a@x' } }) };

function fetchRecorder(pageStatus = 200) {
  const puts = [];
  const impl = async (url, opts = {}) => {
    if (url === '/config') return configOk;
    puts.push({ url, body: JSON.parse(opts.body) });
    return { ok: pageStatus < 300, status: pageStatus };
  };
  return { puts, impl };
}

test('eigene Save-Kennungen gehen als Strings mit, nur die auf der Basis des Entwurfs', async () => {
  const rec = fetchRecorder(200);
  const sw = load({
    drafts: [[KEY(5), draft({ ownSaveIds: [{ id: 'a1', base: 'T0' }, { id: 'b2', base: 'Tx' }, { id: 'c3', base: 'T0' }] })]],
    fetchImpl: rec.impl,
  });
  await sw.flush();
  assert.equal(rec.puts.length, 1);
  assert.deepEqual(rec.puts[0].body.own_save_ids, ['a1', 'c3']);
  assert.equal(rec.puts[0].body.base_html, '<p>alt</p>');
});

test('gesendet: Entwurf fällt, Vermerk sent:, Broadcast mit Stand, Tabs erfahren es', async () => {
  const rec = fetchRecorder(200);
  const sw = load({ drafts: [[KEY(5), draft()]], fetchImpl: rec.impl });
  await sw.flush();
  assert.equal(sw.idb.data.has(KEY(5)), false);
  assert.equal(sw.idb.data.get('sent:' + KEY(5)).savedAt, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(sw.posted)), [{ type: 'del', key: KEY(5), savedAt: 100 }]);
  assert.deepEqual([...sw.notified], ['/content/pages/5']);
});

test('ein stummer Nicht-App-Tab (Share-Reader) blockiert nicht, ein stummer App-Tab schon', async () => {
  const rec = fetchRecorder(200);
  const sw = load({
    drafts: [[KEY(5), draft()]], fetchImpl: rec.impl,
    windows: [{ url: ORIGIN + '/', held: [] }, { url: ORIGIN + '/share/abc', held: null }],
  });
  await sw.flush();
  assert.equal(rec.puts.length, 1);
  const rec2 = fetchRecorder(200);
  const sw2 = load({ drafts: [[KEY(5), draft()]], fetchImpl: rec2.impl, windows: [{ url: ORIGIN + '/', held: null }] });
  await assert.rejects(sw2.flush());
  assert.equal(rec2.puts.length, 0);
});

test('gehaltene Abschnitte fasst er nicht an', async () => {
  const rec = fetchRecorder(200);
  const sw = load({ drafts: [[KEY(5), draft()], [KEY(6), draft()]], fetchImpl: rec.impl, windows: [{ url: ORIGIN + '/', held: [5] }] });
  await sw.flush();
  assert.deepEqual(rec.puts.map((p) => p.url), ['/content/pages/6']);
});

test('5xx: Lauf scheitert (Browser wiederholt), Entwurf bleibt', async () => {
  const rec = fetchRecorder(502);
  const sw = load({ drafts: [[KEY(5), draft()]], fetchImpl: rec.impl });
  await assert.rejects(sw.flush());
  assert.equal(sw.idb.data.has(KEY(5)), true);
});

test('409: Entwurf bleibt für die App, Lauf gilt als erledigt; 401 beendet still', async () => {
  const rec = fetchRecorder(409);
  const sw = load({ drafts: [[KEY(5), draft()]], fetchImpl: rec.impl });
  await sw.flush();
  assert.equal(sw.idb.data.has(KEY(5)), true);
  const rec2 = fetchRecorder(401);
  const sw2 = load({ drafts: [[KEY(5), draft()], [KEY(6), draft()]], fetchImpl: rec2.impl });
  await sw2.flush();
  assert.equal(rec2.puts.length, 1, 'nach 401 kein weiterer PUT');
});

test('Sicherungen und Vermerke sendet er nie', async () => {
  const rec = fetchRecorder(200);
  const sw = load({
    drafts: [[KEY(5) + ':discarded', draft()], ['sent:' + KEY(6), { savedAt: 1, at: Date.now() }], [KEY(7) + ':orphan', draft()]],
    fetchImpl: rec.impl,
  });
  await sw.flush();
  assert.equal(rec.puts.length, 0);
});

test('/config mit 5xx: Lauf scheitert (Browser wiederholt), nicht still „abgemeldet"', async () => {
  const sw = load({
    drafts: [[KEY(5), draft()]],
    fetchImpl: async (url) => (url === '/config' ? { ok: false, status: 502 } : { ok: true, status: 200 }),
  });
  await assert.rejects(sw.flush());
  const sw2 = load({
    drafts: [[KEY(5), draft()]],
    fetchImpl: async (url) => (url === '/config' ? { ok: false, status: 401 } : { ok: true, status: 200 }),
  });
  await sw2.flush();
  assert.equal(sw2.idb.data.has(KEY(5)), true);
});

// Antwort des SW-PUT verloren (Funkloch nach dem Absenden): der Entwurf trägt
// die Kennung des verlorenen Saves samt Basis, und der nächste Lauf nennt sie —
// der Server erkennt den Stand dann als eigenen Vorgänger statt als fremden.
test('Kennung des PUT steht vor dem Absenden im Entwurf; der nächste Lauf nennt sie', async () => {
  const puts = [];
  let lose = true;
  const impl = async (url, opts = {}) => {
    if (url === '/config') return configOk;
    puts.push(JSON.parse(opts.body));
    if (lose) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200 };
  };
  const sw = load({ drafts: [[KEY(5), draft({ ownSaveIds: [{ id: 'a1', base: 'T0' }] })]], fetchImpl: impl });
  await assert.rejects(sw.flush(), /offline/);
  const kept = sw.idb.data.get(KEY(5));
  assert.equal(kept.savedAt, 100, 'Stempel unverändert');
  assert.deepEqual(kept.ownSaveIds.map((e) => e.id), ['a1', puts[0].save_id]);
  assert.equal(kept.ownSaveIds[1].base, 'T0');
  assert.deepEqual(puts[0].own_save_ids, ['a1'], 'erster Lauf: nur die Vorgänger');

  lose = false;
  await sw.flush();
  assert.deepEqual(puts[1].own_save_ids, ['a1', puts[0].save_id]);
  assert.equal(sw.idb.data.has(KEY(5)), false, 'nach Erfolg geräumt');
});
