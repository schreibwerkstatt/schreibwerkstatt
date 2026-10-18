// shared/idb-store.js gegen eine echte IndexedDB-Implementierung (fake-indexeddb)
// statt gegen eine Map: Transaktionen, Verbindungs-Lebenszyklus und
// Versionswechsel verhalten sich wie im Browser.
//
// Gegated: eine vom Browser geschlossene Verbindung (Safari im Hintergrund,
// Speicherdruck) darf die Offline-Warteschlangen nicht bis zum Neuladen lahmlegen.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { forceCloseDatabase } from 'fake-indexeddb';

const { openIdbStore } = await import('../../public/js/shared/idb-store.js');

// Frische Datenbank-Fabrik je Test; merkt sich die geöffneten Verbindungen,
// damit der Test sie von aussen schliessen kann wie der Browser.
let factory;
let opened;
beforeEach(() => {
  factory = new IDBFactory();
  opened = [];
  globalThis.indexedDB = {
    open: (...args) => {
      const req = factory.open(...args);
      req.addEventListener('success', () => opened.push(req.result));
      return req;
    },
    deleteDatabase: (name) => factory.deleteDatabase(name),
  };
});

const sorted = (rows) => [...rows].sort((a, b) => a.qid - b.qid);

test('put / getAll / del laufen durch eine echte Transaktion', async () => {
  const s = openIdbStore('t-roundtrip', 'ops', { keyPath: 'qid' });
  assert.equal(s.usable(), true);
  await s.put({ qid: 1, op: 'a' });
  await s.put({ qid: 2, op: 'b' });
  assert.deepEqual(sorted(await s.getAll()), [{ qid: 1, op: 'a' }, { qid: 2, op: 'b' }]);
  await s.del(1);
  assert.deepEqual(await s.getAll(), [{ qid: 2, op: 'b' }]);
});

test('ohne keyPath: Schlüssel als zweites Argument', async () => {
  const s = openIdbStore('t-outofline', 'kv');
  await s.put({ v: 1 }, 'k1');
  assert.deepEqual(await s.getAll(), [{ v: 1 }]);
  await s.del('k1');
  assert.deepEqual(await s.getAll(), []);
});

test('Browser schliesst die Verbindung (close-Event): der nächste Zugriff öffnet neu', async () => {
  const s = openIdbStore('t-closed', 'ops', { keyPath: 'qid' });
  await s.put({ qid: 1 });
  assert.equal(opened.length, 1);
  forceCloseDatabase(opened[0]);
  // Schon der erste Zugriff danach muss gelingen — sonst scheitert der
  // Flush, der ihn auslöst, und mit ihm alles, was danach in der Outbox steht.
  await s.put({ qid: 2 });
  assert.equal(opened.length, 2, 'neu geöffnet');
  assert.deepEqual(sorted(await s.getAll()).map((r) => r.qid), [1, 2]);
});

test('Verbindung still verloren (kein close-Event): ein Fehlschlag, dann neu geöffnet', async () => {
  const s = openIdbStore('t-lost', 'ops', { keyPath: 'qid' });
  await s.put({ qid: 1 });
  // close() feuert kein close-Event — wie Safaris „connection lost".
  opened[0].close();
  await assert.rejects(s.put({ qid: 2 }), (e) => e.name === 'InvalidStateError');
  await s.put({ qid: 3 });
  assert.equal(opened.length, 2);
  assert.deepEqual(sorted(await s.getAll()).map((r) => r.qid), [1, 3]);
});

test('anderer Tab will upgraden: unsere Verbindung gibt nach, sein Upgrade wird nicht blockiert', async () => {
  const s = openIdbStore('t-upgrade', 'ops', { keyPath: 'qid' });
  await s.put({ qid: 1 });
  const upgraded = await new Promise((resolve, reject) => {
    const req = factory.open('t-upgrade', 2);
    req.onblocked = () => reject(new Error('Upgrade blockiert'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  assert.equal(upgraded.version, 2);
  upgraded.close();
});

test('gescheitertes Öffnen sperrt nicht für immer: der nächste Zugriff versucht es erneut', async () => {
  const s = openIdbStore('t-retry-open', 'ops', { keyPath: 'qid' });
  const realOpen = globalThis.indexedDB.open;
  let fail = true;
  globalThis.indexedDB.open = (...args) => {
    if (!fail) return realOpen(...args);
    fail = false;
    const req = {};
    queueMicrotask(() => { req.error = new DOMException('denied', 'UnknownError'); req.onerror?.(); });
    return req;
  };
  await assert.rejects(s.put({ qid: 1 }));
  await s.put({ qid: 2 });
  assert.deepEqual(await s.getAll(), [{ qid: 2 }]);
});

test('ohne IndexedDB: usable() ist false', () => {
  globalThis.indexedDB = undefined;
  assert.equal(openIdbStore('t-none', 'ops').usable(), false);
});
