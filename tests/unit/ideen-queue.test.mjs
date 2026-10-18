// Gate für die offline vorgemerkten Ideen-Writes (public/js/repo/ideen-queue.js).
//
// DIE INVARIANTEN:
//   1. Online ändert sich nichts: der Write geht direkt an den Server, nichts wird
//      vorgemerkt; ein 4xx/5xx bleibt ein Fehler (keine Warteschlange).
//   2. Nur ein NICHT ZUGESTELLTER Write (Netzfehler, fetchJson: status 0) wird
//      vorgemerkt — die Oberfläche bekommt die angenommene Zeile.
//   3. Eine offline angelegte Idee hat eine temporäre ID; Ändern/Löschen landet
//      in ihrer Anlege-Operation, nie als eigener Request mit negativer ID.
//   4. Mehrere Änderungen derselben Idee fallen zusammen; Löschen verwirft sie.
//   5. Abspielen in Reihenfolge; Netz weg/5xx/401 → Rest bleibt. Anlegen
//      abgewiesen → einmal als Buch-Idee, sonst liegen lassen (`stuck`, der
//      Einfall geht nie verloren). Ändern abgewiesen → Feld für Feld, fällt nur,
//      was der Server ablehnt. Löschen einer schon gelöschten Idee ist erledigt.
//   8. Anlegen trägt einen Idempotenz-Schlüssel; eine Idee an einem offline
//      angelegten Abschnitt wartet auf dessen echte ID.
//   6. Ein anderes Konto sieht und spielt die Warteschlange nicht.
//   7. Nach einem Neuladen ohne Netz liegen die Writes über der gecachten Liste.
import test from 'node:test';
import assert from 'node:assert/strict';

const Q = await import('../../public/js/repo/ideen-queue.js');

function fakeStore() {
  const db = new Map();
  return {
    db,
    usable: () => true,
    getAll: async () => [...db.values()].map((v) => structuredClone(v)),
    put: async (rec) => { db.set(rec.qid, structuredClone(rec)); },
    del: async (qid) => { db.delete(qid); },
  };
}

const netError = () => Object.assign(new TypeError('Failed to fetch'));
const httpError = (status) => ({ ok: false, status, clone() { return this; }, json: async () => ({ error_code: 'X' }) });
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

let calls;
let mode; // 'offline' | 'online' | fn(url, opts)
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  if (mode === 'offline') throw netError();
  if (typeof mode === 'function') return mode(url, opts);
  return ok({ id: 1, content: 'srv' });
};

function setup(owner = 'a@x.ch') {
  calls = [];
  mode = 'offline';
  const store = fakeStore();
  Q.initIdeenQueue(store);
  Q.setIdeenQueueOwner(owner);
  return store;
}

test('online: direkt an den Server, nichts vorgemerkt; ein 400 bleibt ein Fehler', async () => {
  const store = setup();
  mode = 'online';
  const row = await Q.createIdee({ book_id: 5, content: 'x' });
  assert.equal(row.id, 1);
  assert.equal(store.db.size, 0);
  mode = () => httpError(400);
  await assert.rejects(Q.patchIdee({ id: 3, book_id: 5 }, { status: 'erledigt' }));
  assert.equal(store.db.size, 0, 'ein abgewiesener Write wird nicht vorgemerkt');
});

test('offline anlegen: angenommene Zeile mit temporärer ID, Ändern/Löschen ohne Request', async () => {
  const store = setup();
  const row = await Q.createIdee({ book_id: 5, page_id: 7, content: 'Einfall' });
  assert.ok(row.id < 0 && row.pending);
  assert.equal(row.status, 'offen');
  assert.equal(row.page_id, 7);
  calls = [];
  const edited = await Q.patchIdee(row, { content: 'Einfall, besser' });
  assert.equal(edited.content, 'Einfall, besser');
  assert.equal(calls.length, 0, 'nie ein Request mit negativer ID');
  assert.equal(store.db.size, 1, 'Änderung steckt in der Anlege-Operation');
  await Q.deleteIdee(row);
  assert.equal(store.db.size, 0);
  assert.equal(calls.length, 0);
});

test('offline ändern: Felder fallen zusammen, Löschen verwirft die Änderungen', async () => {
  const store = setup();
  const idee = { id: 9, book_id: 5, content: 'a', status: 'offen' };
  const r1 = await Q.patchIdee(idee, { status: 'in_arbeit' });
  assert.equal(r1.status, 'in_arbeit');
  await Q.patchIdee(idee, { content: 'b' });
  const ops = [...store.db.values()];
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0].fields, { status: 'in_arbeit', content: 'b' });
  await Q.deleteIdee(idee);
  const after = [...store.db.values()];
  assert.equal(after.length, 1);
  assert.equal(after[0].op, 'delete');
});

test('Abspielen in Reihenfolge; Netz weg bricht ab und lässt den Rest liegen', async () => {
  const store = setup();
  await Q.createIdee({ book_id: 5, content: 'eins' });
  await Q.patchIdee({ id: 9, book_id: 5 }, { status: 'erledigt' });
  await Q.deleteIdee({ id: 10, book_id: 5 });
  calls = [];
  let n = 0;
  mode = () => { if (++n === 2) throw netError(); return ok({ id: 100 }); };
  const r1 = await Q.flushIdeenQueue();
  assert.deepEqual([r1.done, r1.offline], [1, true]);
  assert.equal(store.db.size, 2);
  mode = 'online';
  const r2 = await Q.flushIdeenQueue();
  assert.deepEqual([r2.done, r2.dropped, r2.offline], [2, 0, false]);
  assert.equal(store.db.size, 0);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    'POST /ideen', 'PATCH /ideen/9', 'PATCH /ideen/9', 'DELETE /ideen/10',
  ]);
});

test('Anlegen abgewiesen → einmal als Buch-Idee; Ändern abgewiesen fällt; Löschen 404 ist erledigt', async () => {
  const store = setup();
  await Q.createIdee({ book_id: 5, page_id: 7, content: 'an gelöschtem Abschnitt' });
  await Q.patchIdee({ id: 9, book_id: 5 }, { status: 'erledigt' });
  await Q.deleteIdee({ id: 10, book_id: 5 });
  calls = [];
  mode = (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (opts.method === 'POST' && body.page_id) return httpError(404);
    if (opts.method === 'PATCH') return httpError(400);
    if (opts.method === 'DELETE') return httpError(404);
    return ok({ id: 101 });
  };
  const r = await Q.flushIdeenQueue();
  assert.deepEqual([r.done, r.dropped], [2, 1]);
  assert.equal(store.db.size, 0);
  const posts = calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.page_id, undefined, 'Rückfall ohne Anker');
  assert.equal(posts[1].body.content, 'an gelöschtem Abschnitt');
});

test('5xx bricht ab und behält die Operation', async () => {
  const store = setup();
  await Q.createIdee({ book_id: 5, content: 'x' });
  mode = () => httpError(503);
  const r = await Q.flushIdeenQueue();
  assert.equal(r.retry, true);
  assert.equal(store.db.size, 1);
});

test('temporäre Abschnitts-ID wird beim Abspielen auf die echte gezogen', async () => {
  setup();
  await Q.createIdee({ book_id: 5, page_id: -123, content: 'x' });
  calls = [];
  mode = 'online';
  await Q.flushIdeenQueue(undefined, new Map([[-123, 77]]));
  assert.equal(calls[0].body.page_id, 77);
});

test('anderes Konto: sieht und spielt die Warteschlange nicht', async () => {
  const store = setup('a@x.ch');
  await Q.createIdee({ book_id: 5, content: 'von a' });
  Q.setIdeenQueueOwner('b@x.ch');
  assert.equal(await Q.pendingIdeenCount(), 0);
  mode = 'online';
  calls = [];
  const r = await Q.flushIdeenQueue();
  assert.equal(r.done, 0);
  assert.equal(calls.length, 0);
  assert.equal(store.db.size, 1);
});

test('Überlagern: neue, geänderte und gelöschte Ideen über der gecachten Liste', async () => {
  setup();
  const created = await Q.createIdee({ book_id: 5, page_id: 7, content: 'neu' });
  await Q.createIdee({ book_id: 5, page_id: 8, content: 'anderer Abschnitt' });
  await Q.patchIdee({ id: 1, book_id: 5, page_id: 7, status: 'offen' }, { status: 'erledigt' });
  await Q.deleteIdee({ id: 2, book_id: 5, page_id: 7 });
  const cached = [
    { id: 1, book_id: 5, page_id: 7, status: 'offen', content: 'a' },
    { id: 2, book_id: 5, page_id: 7, status: 'offen', content: 'b' },
  ];
  const out = await Q.overlayPendingIdeen(cached, (r) => r.page_id === 7);
  assert.deepEqual(out.map((r) => r.id).sort(), [created.id, 1].sort());
  assert.equal(out.find((r) => r.id === 1).status, 'erledigt');
});

test('isUndelivered: Netzfehler und Timeout ja, HTTP-Fehler nein', () => {
  assert.equal(Q.isUndelivered(Object.assign(new TypeError('x'), { status: 0 })), true);
  assert.equal(Q.isUndelivered(new TypeError('x')), true);
  assert.equal(Q.isUndelivered(Object.assign(new Error('t'), { name: 'TimeoutError' })), true);
  assert.equal(Q.isUndelivered(Object.assign(new Error('HTTP 500'), { status: 500 })), false);
  assert.equal(Q.isUndelivered(Object.assign(new Error('HTTP 503'), { status: 503, body: { error: 'offline' } })), true);
});

test('Anlegen trägt einen Idempotenz-Schlüssel, das Nachspielen denselben', async () => {
  const keys = [];
  setup();
  mode = (url, opts) => { keys.push(opts.headers['Idempotency-Key']); throw netError(); };
  await Q.createIdee({ book_id: 5, content: 'x' });
  mode = (url, opts) => { keys.push(opts.headers['Idempotency-Key']); return ok({ id: 9 }); };
  await Q.flushIdeenQueue();
  assert.match(keys[0], /^op-/);
  assert.equal(keys[1], keys[0]);
});

test('401 hält das Abspielen an; Anlegen, das auch als Buch-Idee scheitert, bleibt liegen', async () => {
  const store = setup();
  await Q.createIdee({ book_id: 5, page_id: 7, content: 'Einfall' });
  mode = () => httpError(401);
  const r1 = await Q.flushIdeenQueue();
  assert.equal(r1.auth, true);
  assert.equal(store.db.size, 1);
  mode = () => httpError(403);
  const r2 = await Q.flushIdeenQueue();
  assert.equal(r2.stuck, 1);
  assert.equal(r2.dropped, 0);
  assert.equal(store.db.size, 1, 'Text bleibt');
  assert.equal((await Q.stuckIdeenOps()).length, 1);
  mode = 'online';
  assert.equal((await Q.flushIdeenQueue()).done, 0, 'liegt, bis erneut versucht');
  await Q.retryStuckIdeenOps();
  assert.equal((await Q.flushIdeenQueue()).done, 1);
  assert.equal(store.db.size, 0);
});

test('Zusammengelegte Änderung, die der Server ablehnt, geht Feld für Feld', async () => {
  setup();
  await Q.patchIdee({ id: 9, book_id: 5, status: 'erledigt' }, { status: 'offen' });
  await Q.patchIdee({ id: 9, book_id: 5, status: 'erledigt' }, { content: 'neu', page_id: 4 });
  calls = [];
  mode = (url, opts) => {
    const b = JSON.parse(opts.body);
    if ('page_id' in b) return httpError(400);
    if (Object.keys(b).length > 1) return httpError(400);
    return ok({ id: 9 });
  };
  const r = await Q.flushIdeenQueue();
  assert.deepEqual([r.done, r.dropped], [1, 1]);
  const sentBodies = calls.map((c) => c.body);
  assert.ok(sentBodies.some((b) => b && b.content === 'neu' && Object.keys(b).length === 1), 'Text ging durch');
});

test('Idee an offline angelegtem Abschnitt: wartet, bis er angelegt ist — auch über Durchgänge und beim Verschieben', async () => {
  const S = await import('../../public/js/repo/structure-queue.js');
  const ls = new Map();
  globalThis.localStorage = {
    get length() { return ls.size; }, key: (i) => [...ls.keys()][i] ?? null,
    getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k),
  };
  S.initStructureQueue({ usable: () => false });
  S.setStructureOwner('a@x.ch');
  const page = S.queueCreatePage({ chapter_id: 3, name: 'N' }, { bookId: 5 });
  const store = setup();
  await Q.createIdee({ book_id: 5, page_id: page.id, content: 'am neuen Abschnitt' });
  await Q.patchIdee({ id: 9, book_id: 5, page_id: 1 }, { page_id: page.id });
  calls = [];
  mode = 'online';
  const r1 = await Q.flushIdeenQueue();
  assert.equal(r1.waiting, 2);
  assert.equal(calls.length, 0, 'nie eine negative ID ans Netz');
  await S.flushStructureQueue(async () => ({ id: 444, updated_at: 'T' }));
  const r2 = await Q.flushIdeenQueue();
  assert.equal(r2.done, 2);
  assert.deepEqual(calls.map((c) => c.body.page_id), [444, 444]);
  assert.equal(store.db.size, 0);
});

test('Online-Write nimmt einer älteren vorgemerkten Änderung dieselben Felder weg', async () => {
  const store = setup();
  await Q.patchIdee({ id: 9, book_id: 5 }, { content: 'alt', status: 'in_arbeit' });
  mode = 'online';
  await Q.patchIdee({ id: 9, book_id: 5 }, { content: 'neu' });
  const [op] = [...store.db.values()];
  assert.deepEqual(op.fields, { status: 'in_arbeit' });
  await Q.patchIdee({ id: 9, book_id: 5 }, { status: 'offen' });
  assert.equal(store.db.size, 0);
});
