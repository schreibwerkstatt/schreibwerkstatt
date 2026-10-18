// Ablage der Struktur-Warteschlange (repo/structure-queue.js) in IndexedDB.
// Die Fachlogik (Anlegen, Umbenennen, Abspielen) prüft structure-queue.test.mjs
// über den localStorage-Rückfall; hier geht es nur um die Ablage.
//
// DIE INVARIANTEN:
//   1. Mit IndexedDB landet nichts in localStorage — ein offline angelegter
//      Abschnitt mit langem Text scheitert nicht am localStorage-Deckel.
//   2. Gelesen wird synchron aus dem Spiegel; ein Neustart (neuer Spiegel aus
//      der Datenbank) sieht dieselbe Warteschlange in derselben Reihenfolge.
//   3. Je Operation ein Datensatz: Abspielen löscht genau die erledigte.
//   4. Eine alte localStorage-Liste zieht beim Start um und fällt danach.
//   5. Scheitert ein IndexedDB-Write, landet die Liste in localStorage (und
//      zieht beim nächsten Start wieder um) — nichts geht verloren.
//   6. Andere Konten sehen die Operationen nicht; andere Tabs werden nachgeführt.
import test from 'node:test';
import assert from 'node:assert/strict';

const ls = new Map();
globalThis.localStorage = {
  get length() { return ls.size; },
  key(i) { return [...ls.keys()][i] ?? null; },
  getItem(k) { return ls.has(k) ? ls.get(k) : null; },
  setItem(k, v) { ls.set(k, String(v)); },
  removeItem(k) { ls.delete(k); },
  clear() { ls.clear(); },
};
const events = [];
globalThis.window = globalThis.window || {};
Object.assign(globalThis.window, {
  addEventListener: () => {}, removeEventListener: () => {},
  dispatchEvent: (e) => { events.push(e); return true; },
});
let channel = null;
globalThis.BroadcastChannel = class { constructor() { channel = this; this.sent = []; } postMessage(m) { this.sent.push(m); } };

const Q = await import('../../public/js/repo/structure-queue.js');

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeStore(initial = []) {
  const db = new Map(initial.map((r) => [r.qid, structuredClone(r)]));
  let failPut = false;
  return {
    db,
    failPuts(v) { failPut = v; },
    usable: () => true,
    getAll: async () => [...db.values()].map((r) => structuredClone(r)),
    put: async (rec) => { await tick(); if (failPut) throw new Error('idb'); db.set(rec.qid, structuredClone(rec)); },
    del: async (qid) => { await tick(); db.delete(qid); },
  };
}

async function boot(store, owner = 'a@x') {
  Q.setStructureOwner(owner);
  await Q.initStructureQueue(store);
  return store;
}

test.beforeEach(() => { ls.clear(); events.length = 0; });

test('mit IndexedDB: nichts in localStorage, Neustart sieht dieselbe Warteschlange', async () => {
  const store = await boot(fakeStore());
  const big = '<p>' + 'x'.repeat(200_000) + '</p>';
  const page = Q.queueCreatePage({ chapter_id: 3, name: 'Neu', html: big }, { bookId: 7 });
  assert.ok(page.id < 0);
  Q.queueRename('chapter', 4, 'Kap');
  assert.equal(Q.pendingStructureCount(), 2, 'synchron aus dem Spiegel');
  await tick(); await tick();
  assert.equal(ls.size, 0, 'kein localStorage-Eintrag');
  assert.equal(store.db.size, 2);
  // Neustart: Spiegel aus der Datenbank.
  await Q.initStructureQueue(store);
  const ops = Q.pendingStructureOps();
  assert.deepEqual(ops.map((o) => o.op), ['createPage', 'rename']);
  assert.equal(Q.pendingPage(page.id).html, big);
});

test('Abspielen löscht genau die erledigte Operation', async () => {
  const store = await boot(fakeStore());
  Q.queueCreatePage({ chapter_id: 3, name: 'A', html: '' }, { bookId: 7 });
  Q.queueRename('page', 9, 'B');
  await tick(); await tick();
  let n = 0;
  const res = await Q.flushStructureQueue(async (op) => {
    if (++n === 2) throw new TypeError('Failed to fetch');
    return { id: 50 };
  });
  assert.equal(res.done, 1);
  await tick(); await tick();
  assert.deepEqual([...store.db.values()].map((o) => o.op), ['rename']);
  assert.equal(Q.pendingStructureCount(), 1);
});

test('alte localStorage-Liste zieht beim Start um und fällt danach', async () => {
  ls.set('structure_queue_u:a@x', JSON.stringify([
    { qid: 'q1', op: 'rename', kind: 'page', id: 5, name: 'Alt', at: 1 },
  ]));
  const store = await boot(fakeStore());
  assert.equal(ls.size, 0);
  assert.equal(store.db.get('q1').owner, 'a@x');
  assert.equal(Q.pendingStructureCount(), 1);
});

test('gescheiterter IndexedDB-Write: Liste geht nach localStorage, nichts verloren', async () => {
  const store = await boot(fakeStore());
  store.failPuts(true);
  Q.queueRename('page', 9, 'B');
  await tick(); await tick();
  const saved = JSON.parse(ls.get('structure_queue_u:a@x'));
  assert.deepEqual(saved.map((o) => o.name), ['B']);
  // Nächster Start zieht sie wieder um.
  store.failPuts(false);
  await Q.initStructureQueue(store);
  assert.equal(ls.size, 0);
  assert.equal(Q.pendingStructureCount(), 1);
});

test('anderes Konto sieht nichts; ein anderer Tab wird per Broadcast nachgeführt', async () => {
  await boot(fakeStore());
  Q.queueRename('page', 9, 'B');
  await tick(); await tick();
  assert.ok(channel.sent.some((m) => m.type === 'put'));
  Q.setStructureOwner('b@x');
  assert.equal(Q.pendingStructureCount(), 0);
  // Broadcast aus einem anderen Tab desselben Kontos b@x.
  channel.onmessage({ data: { type: 'put', op: { qid: 'z', op: 'rename', kind: 'page', id: 1, name: 'T', owner: 'b@x', seq: 1 } } });
  assert.equal(Q.pendingStructureCount(), 1);
  channel.onmessage({ data: { type: 'del', qid: 'z' } });
  assert.equal(Q.pendingStructureCount(), 0);
});
