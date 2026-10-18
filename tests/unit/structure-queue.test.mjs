// Offline vorgemerkte Strukturänderungen (repo/structure-queue.js) und ihre
// Anbindung an contentRepo + Reconnect-Outbox: Abschnitt anlegen bekommt eine
// temporäre ID und trägt seinen Inhalt bis zum Abspielen selbst; Umbenennen
// fällt pro Objekt zusammen; ein Timeout wird vorgemerkt und trägt denselben
// Idempotenz-Schlüssel wie der erste Versuch (ein angekommener Request legt
// nicht doppelt an); ein abgewiesenes Anlegen verwirft seinen Inhalt nie; die
// echte ID bleibt nach dem Abspielen auffindbar (resolveTempId).
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
globalThis.sessionStorage = globalThis.sessionStorage || {
  _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); },
};
const events = [];
globalThis.window = globalThis.window || {};
Object.assign(globalThis.window, {
  addEventListener: () => {}, removeEventListener: () => {},
  dispatchEvent: (e) => { events.push(e); return true; },
});
globalThis.Alpine = { store: () => ({ selectedBookId: 7 }) };

const Q = await import('../../public/js/repo/structure-queue.js');
const { contentRepo } = await import('../../public/js/repo/content.js');
const { appOutboxMethods } = await import('../../public/js/app/app-outbox.js');
const { readDraft, writeDraft } = await import('../../public/js/editor/draft-storage.js');

const offlineErr = () => new TypeError('Failed to fetch');
const httpErr = (status) => Object.assign(new Error('HTTP ' + status), { status });

let fetchImpl = null;
globalThis.fetch = (...a) => fetchImpl(...a);
const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body, headers: { get: () => null } });

test.beforeEach(() => { ls.clear(); events.length = 0; Q.setStructureOwner('a@x'); });

test('createPage ohne Netz → temporäre ID, Inhalt in der Operation, Ansage', async () => {
  fetchImpl = async () => { throw offlineErr(); };
  const p = await contentRepo.createPage({ chapter_id: 3, name: 'Neu', html: '<p></p>' });
  assert.ok(p.id < 0);
  assert.equal(p.pending, true);
  assert.equal(p.chapter_id, 3);
  assert.equal(Q.pendingStructureCount(), 1);
  assert.equal(events.at(-1).detail.queued, true);
  // Save und Laden der temporären ID gehen nie ans Netz.
  fetchImpl = async () => { throw new Error('kein Netz-Call erwartet'); };
  await contentRepo.savePage(p.id, { html: '<p>Text</p>', name: 'Neu' }, { writer: 'notebook' });
  assert.equal((await contentRepo.loadPage(p.id)).html, '<p>Text</p>');
  await contentRepo.updatePage(p.id, { name: 'Neuer Name' });
  assert.equal((await contentRepo.loadPage(p.id)).name, 'Neuer Name');
  await contentRepo.deletePage(p.id, { bookId: 7 });
  assert.equal(Q.pendingStructureCount(), 0);
});

test('Timeout wird vorgemerkt, und derselbe Idempotenz-Schlüssel geht beim Nachspielen mit', async () => {
  const keys = [];
  fetchImpl = async (url, opts) => {
    keys.push(opts.headers['Idempotency-Key']);
    throw Object.assign(new Error('content timeout'), { name: 'TimeoutError' });
  };
  const p = await contentRepo.createPage({ chapter_id: 3, name: 'X' });
  assert.ok(p.id < 0);
  const [op] = Q.pendingStructureOps();
  assert.match(op.opKey, /^op-/);
  assert.equal(op.opKey, keys[0], 'Schlüssel des ersten Versuchs');
  fetchImpl = async (url, opts) => { keys.push(opts.headers['Idempotency-Key']); return json({ id: 55, updated_at: 'T' }); };
  await Q.flushStructureQueue((o) => contentRepo.sendQueuedStructureOp(o));
  assert.equal(keys[1], keys[0], 'Nachspielen trägt denselben Schlüssel');
});

test('Externer Abbruch ohne Timeout bleibt ein Fehler', async () => {
  fetchImpl = async () => { throw Object.assign(new Error('x'), { name: 'Error' }); };
  await assert.rejects(contentRepo.createPage({ chapter_id: 3, name: 'X' }));
  assert.equal(Q.pendingStructureCount(), 0);
});

test('Umbenennen ohne Netz: nur ein reiner Namenswechsel, fällt pro Objekt zusammen', async () => {
  fetchImpl = async () => { throw offlineErr(); };
  await contentRepo.updatePage(5, { name: 'A' });
  await contentRepo.updatePage(5, { name: 'B' });
  await contentRepo.updateChapter(9, { name: 'K' }, { bookId: 7 });
  await assert.rejects(contentRepo.updateChapter(9, { excluded: true }, { bookId: 7 }));
  const ops = Q.pendingStructureOps();
  assert.deepEqual(ops.map((o) => [o.kind, o.id, o.name]), [['page', 5, 'B'], ['chapter', 9, 'K']]);
});

test('Abspielen: in Reihenfolge, Anlegen liefert die echte ID, Netz weg bricht ab', async () => {
  Q.queueCreatePage({ chapter_id: 3, name: 'N', html: '<p>a</p>' }, { bookId: 7 });
  Q.queueRename('chapter', 9, 'K', { bookId: 7 });
  const sent = [];
  const r = await Q.flushStructureQueue(async (op) => {
    sent.push(op.op);
    if (op.op === 'rename') throw offlineErr();
    return { id: 101, html: op.body.html, updated_at: 'T1' };
  });
  assert.deepEqual(sent, ['createPage', 'rename']);
  assert.equal(r.offline, true);
  assert.equal(r.remaps[0].page.id, 101);
  assert.deepEqual(Q.pendingStructureOps().map((o) => o.op), ['rename'], 'Erledigtes läuft nie doppelt');
});

test('Abspielen: 5xx hält an (vorübergehend), abgewiesenes Umbenennen fällt', async () => {
  Q.queueRename('page', 5, 'A', { bookId: 7 });
  let r = await Q.flushStructureQueue(async () => { throw httpErr(503); });
  assert.equal(r.retry, true);
  assert.equal(Q.pendingStructureCount(), 1);
  r = await Q.flushStructureQueue(async () => { throw httpErr(404); });
  assert.equal(r.dropped, 1);
  assert.equal(Q.pendingStructureCount(), 0);
});

test('Anlegen abgewiesen (Kapitel weg) → ohne Kapitel im Buch; scheitert auch das, bleibt der Inhalt', async () => {
  Q.queueCreatePage({ chapter_id: 3, name: 'N', html: '<p>wichtig</p>' }, { bookId: 7 });
  const bodies = [];
  let r = await Q.flushStructureQueue(async (op) => {
    bodies.push(op.body);
    if (op.body.chapter_id != null) throw httpErr(404);
    return { id: 102, html: op.body.html, updated_at: 'T2' };
  });
  assert.equal(bodies[1].chapter_id, null);
  assert.equal(bodies[1].book_id, 7);
  assert.equal(r.remaps[0].page.id, 102);

  Q.queueCreatePage({ chapter_id: 3, name: 'M', html: '<p>bleibt</p>' }, { bookId: 7 });
  r = await Q.flushStructureQueue(async () => { throw httpErr(403); });
  assert.equal(r.stuck, 1);
  assert.equal(Q.stuckStructureOps()[0].body.html, '<p>bleibt</p>');
  // Der nächste Lauf überspringt sie, statt erneut zu scheitern.
  let calls = 0;
  r = await Q.flushStructureQueue(async () => { calls++; return {}; });
  assert.equal(calls, 0);
});

test('Save während des Anlegens geht nicht verloren (lateHtml)', async () => {
  const p = Q.queueCreatePage({ chapter_id: 3, name: 'N', html: '<p>alt</p>' }, { bookId: 7 });
  const r = await Q.flushStructureQueue(async (op) => {
    Q.patchPendingPage(p.id, { html: '<p>während</p>' });
    return { id: 103, html: op.body.html, updated_at: 'T3' };
  });
  assert.equal(r.remaps[0].lateHtml, '<p>während</p>');
});

test('Outbox: echte ID überall nachgezogen — Baum, offene Seite, Entwurf, Basis', () => {
  const tempId = -42;
  const page = { id: tempId, name: 'N', pending: true };
  writeDraft(tempId, '<p>offline weiter</p>', '', null);
  const root = Object.assign(Object.create(appOutboxMethods), {
    $store: { nav: { pages: [page], tree: [{ type: 'chapter', pages: [page] }] } },
    currentPage: page, editMode: true, originalHtml: '',
    _bumpTreeRev() {}, _rebuildTreeOrderMaps() {},
  });
  root._applyTempPageRemaps([{ tempId, page: { id: 104, html: '<p>angelegt</p>', updated_at: 'T4', position: 2 } }]);
  assert.equal(page.id, 104);
  assert.equal(page.pending, undefined);
  assert.equal(root.currentPage.updated_at, 'T4');
  assert.equal(root.originalHtml, '<p>angelegt</p>');
  assert.equal(readDraft(tempId), null);
  const d = readDraft(104);
  assert.equal(d.html, '<p>offline weiter</p>');
  assert.equal(d.originalUpdatedAt, 'T4', 'Basis = angelegter Stand, die Outbox sendet ohne Konflikt');
});

test('Outbox: nach dem Neuladen ohne Netz liegt Vorgemerktes über dem Baum', () => {
  const p = Q.queueCreatePage({ chapter_id: 3, name: 'Offline', html: '' }, { bookId: 7 });
  Q.queueRename('page', 5, 'Neuer Name', { bookId: 7 });
  const ch = { type: 'chapter', id: 3, pages: [] };
  const inserted = [];
  const root = Object.assign(Object.create(appOutboxMethods), {
    $store: { nav: { pages: [{ id: 5, name: 'Alt' }], tree: [ch] } },
    _findTreeChapter: (id) => (id === 3 ? ch : null),
    _insertCreatedPageIntoTree(item, page) { inserted.push(page.id); item.pages.push(page); this.$store.nav.pages.push(page); },
    _bumpTreeRev() {}, _rebuildTreeOrderMaps() {},
  });
  root._overlayPendingStructure(7);
  assert.deepEqual(inserted, [p.id]);
  assert.equal(root.$store.nav.pages[0].name, 'Neuer Name');
  root._overlayPendingStructure(7);
  assert.equal(inserted.length, 1, 'ein zweites Overlay (Reload) legt den Abschnitt nicht doppelt an');
});

test('401 hält das Abspielen an, nichts fällt, nichts bleibt hängen', async () => {
  Q.queueCreatePage({ chapter_id: 3, name: 'N' }, { bookId: 7 });
  Q.queueRename('page', 5, 'R', { bookId: 7 });
  const r = await Q.flushStructureQueue(async () => { throw httpErr(401); });
  assert.equal(r.auth, true);
  assert.equal(r.stuck, 0);
  assert.equal(r.dropped, 0);
  assert.equal(Q.pendingStructureCount(), 2);
  assert.equal(Q.stuckStructureOps().length, 0);
});

test('Abgewiesenes Anlegen: erneut versuchen gibt frei, verwerfen nur ausdrücklich', async () => {
  Q.queueCreatePage({ chapter_id: 3, name: 'N', html: '<p>wichtig</p>' }, { bookId: 7 });
  await Q.flushStructureQueue(async () => { throw httpErr(403); });
  const [stuck] = Q.stuckStructureOps();
  assert.ok(stuck);
  assert.equal(Q.retryStuckStructureOps(), true);
  assert.equal(Q.stuckStructureOps().length, 0);
  const r = await Q.flushStructureQueue(async (op) => ({ id: 88, html: op.body.html, updated_at: 'T' }));
  assert.equal(r.done, 1);
  Q.queueCreatePage({ chapter_id: 3, name: 'M' }, { bookId: 7 });
  await Q.flushStructureQueue(async () => { throw httpErr(403); });
  assert.equal(Q.discardStructureOp(Q.stuckStructureOps()[0].qid), true);
  assert.equal(Q.pendingStructureCount(), 0);
});

test('Nach dem Abspielen: temporäre ID führt zum echten Abschnitt (Save, Laden, Löschen, zweiter Tab)', async () => {
  const p = Q.queueCreatePage({ chapter_id: 3, name: 'N', html: '<p>a</p>' }, { bookId: 7 });
  await Q.flushStructureQueue(async (op) => ({ id: 321, html: op.body.html, updated_at: 'T1' }));
  assert.equal(Q.resolveTempId(p.id), 321);
  assert.equal(Q.isTempPagePending(p.id), false);
  const seen = [];
  fetchImpl = async (url, opts = {}) => {
    seen.push(`${opts.method || 'GET'} ${url}`);
    return json({ id: 321, html: '<p>b</p>', updated_at: 'T2' });
  };
  await contentRepo.savePage(p.id, { html: '<p>b</p>' }, { writer: 'notebook' });
  await contentRepo.loadPage(p.id, { fresh: true });
  await contentRepo.deletePage(p.id, { bookId: 7 });
  assert.ok(seen.some((x) => x.startsWith('PUT /content/pages/321')), seen.join(','));
  assert.ok(seen.some((x) => x.startsWith('DELETE /content/pages/321')), seen.join(','));
  assert.ok(!seen.some((x) => x.includes('/pages/-')), 'nie eine negative ID ans Netz');
});

test('Online umbenannt: ältere vorgemerkte Umbenennung desselben Objekts fällt', async () => {
  Q.queueRename('page', 5, 'Alt', { bookId: 7 });
  Q.queueRename('chapter', 9, 'K-alt', { bookId: 7 });
  fetchImpl = async () => json({ id: 5, name: 'Neu' });
  await contentRepo.updatePage(5, { name: 'Neu' });
  await contentRepo.updateChapter(9, { name: 'K-neu' }, { bookId: 7 });
  assert.equal(Q.pendingStructureCount(), 0);
});

test('Abgewiesene (stuck) Operationen zählen nicht als wartend', async () => {
  Q.queueCreatePage({ chapter_id: 3, name: 'N' }, { bookId: 7 });
  await Q.flushStructureQueue(async () => { throw httpErr(403); });
  assert.equal(Q.stuckStructureOps().length, 1);
  assert.equal(Q.pendingStructureCount(), 0);
  Q.discardStructureOp(Q.stuckStructureOps()[0].qid);
});
