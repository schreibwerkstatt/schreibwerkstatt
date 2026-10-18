// editor/draft-idb.js gegen eine echte IndexedDB-Implementierung (fake-indexeddb).
//
// Gegated: weder ein gescheiterter Write noch eine vom Browser geschlossene
// Verbindung sperrt die Entwurfs-Ablage für die Sitzung — sonst liefen danach
// auch alle Löschungen ins Leere, und ein geräumter Entwurf käme beim nächsten
// Start aus IndexedDB zurück.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, forceCloseDatabase } from 'fake-indexeddb';

const factory = new IDBFactory();
const opened = [];
globalThis.indexedDB = {
  open: (...args) => {
    const req = factory.open(...args);
    req.addEventListener('success', () => opened.push(req.result));
    return req;
  },
  deleteDatabase: (name) => factory.deleteDatabase(name),
};

const { draftIdb } = await import('../../public/js/editor/draft-idb.js');

test('Write scheitert (ungültiger Wert) → Ablage bleibt nutzbar, Löschen geht weiter', async () => {
  await draftIdb.put('k1', { html: '<p>a</p>', savedAt: 1 });
  await assert.rejects(draftIdb.put('k2', { fn: () => {} }), 'nicht klonbar → Write scheitert');
  assert.equal(draftIdb.usable(), true);
  await draftIdb.del('k1');
  assert.deepEqual(await draftIdb.getAll(), []);
});

test('Vom Browser geschlossene Verbindung → nächster Zugriff öffnet neu', async () => {
  await draftIdb.put('k3', { html: '<p>b</p>', savedAt: 2 });
  for (const db of opened) forceCloseDatabase(db);
  await new Promise((r) => setTimeout(r, 0));
  await draftIdb.put('k4', { html: '<p>c</p>', savedAt: 3 });
  const keys = (await draftIdb.getAll()).map(([k]) => k).sort();
  assert.deepEqual(keys, ['k3', 'k4']);
  assert.equal(draftIdb.usable(), true);
});
