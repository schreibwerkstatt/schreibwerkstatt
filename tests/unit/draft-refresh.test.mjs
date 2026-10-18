// refreshDraft / whenDraftSettled (editor/draft-storage.js): der Abgleich, den
// die Outbox unter dem Web Lock des Abschnitts macht, bevor sie sendet.
//
// Hat ein anderer Tab oder der Service Worker den Entwurf schon gesendet und
// geräumt, weiss der Spiegel dieses Tabs davon erst per Broadcast — und der
// kommt nach der Lock-Freigabe. Ohne Abgleich ginge derselbe Stand ein zweites
// Mal raus. Der Abgleich darf aber nie einen Stand verwerfen, der nur hier lebt
// (Put unterwegs oder gescheitert). Ende-zu-Ende: tests/e2e-app/offline-concurrency.spec.js.
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
globalThis.window = { dispatchEvent: () => true };

const { initDraftStore, whenDraftsReady, readDraft, writeDraft, clearDraft, refreshDraft, whenDraftSettled, setDraftOwner, listDraftPageIds } =
  await import('../../public/js/editor/draft-storage.js');

const tick = () => new Promise((r) => setTimeout(r, 0));

// IndexedDB-Ersatz mit `get`; `slow()` hält Puts/Deletes an, bis `release`.
function fakeIdb(initial = []) {
  const db = new Map(initial);
  let failPut = false;
  let gate = null;
  const wait = async () => { await tick(); if (gate) await gate; };
  return {
    db,
    usable: () => true,
    present: () => true,
    put: async (k, v) => { await wait(); if (failPut) throw new Error('idb'); db.set(k, v); },
    del: async (k) => { await wait(); db.delete(k); },
    get: async (k) => db.get(k),
    getAll: async () => [...db.entries()],
    broadcast: () => {},
    onMessage: () => {},
    failPuts() { failPut = true; },
    slow() { let release; gate = new Promise((r) => { release = r; }); return () => { gate = null; release(); }; },
  };
}

const K = (id) => `editor_draft_${id}`;
const rec = (html, savedAt = 1) => ({ html, originalHtml: '<p>b</p>', originalUpdatedAt: 'T0', savedAt });

test.beforeEach(() => { ls.clear(); setDraftOwner(null); });

test('anderswo gesendet und geräumt: der Spiegel lässt den Entwurf fallen', async () => {
  const idb = fakeIdb([[K(1), rec('<p>x</p>')]]);
  initDraftStore(idb);
  await whenDraftsReady();
  assert.ok(readDraft(1));
  idb.db.delete(K(1)); // anderer Tab / Service Worker, Broadcast noch unterwegs
  assert.equal(await refreshDraft(1), null);
  assert.deepEqual(listDraftPageIds(), []);
});

test('anderswo neuer geschrieben: der jüngere Stand gewinnt', async () => {
  const idb = fakeIdb([[K(2), rec('<p>alt</p>', 1)]]);
  initDraftStore(idb);
  await whenDraftsReady();
  idb.db.set(K(2), rec('<p>neu</p>', 5));
  assert.equal((await refreshDraft(2)).html, '<p>neu</p>');
});

test('eigener Put noch unterwegs: wird abgewartet, nichts fällt', async () => {
  const idb = fakeIdb();
  initDraftStore(idb);
  await whenDraftsReady();
  const release = idb.slow();
  writeDraft(3, '<p>gerade getippt</p>', '<p>b</p>', 'T0');
  const p = refreshDraft(3);
  await tick();
  release();
  assert.equal((await p).html, '<p>gerade getippt</p>');
  assert.ok(idb.db.has(K(3)));
});

test('eigener Put gescheitert: der Stand lebt nur noch hier und bleibt', async () => {
  const idb = fakeIdb();
  initDraftStore(idb);
  await whenDraftsReady();
  idb.failPuts();
  writeDraft(4, '<p>nur hier</p>', '<p>b</p>', 'T0');
  await whenDraftSettled(4);
  ls.clear(); // auch localStorage hatte keinen Platz
  assert.equal((await refreshDraft(4))?.html, '<p>nur hier</p>');
});

test('whenDraftSettled wartet auf das Räumen in IndexedDB', async () => {
  const idb = fakeIdb([[K(5), rec('<p>x</p>')]]);
  initDraftStore(idb);
  await whenDraftsReady();
  const release = idb.slow();
  clearDraft(5);
  let settled = false;
  const w = whenDraftSettled(5).then(() => { settled = true; });
  await tick(); await tick();
  assert.equal(settled, false, 'vor dem Commit nicht erledigt');
  assert.ok(idb.db.has(K(5)));
  release();
  await w;
  assert.equal(idb.db.has(K(5)), false);
});
