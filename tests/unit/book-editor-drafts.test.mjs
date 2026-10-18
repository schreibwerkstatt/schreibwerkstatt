// Bucheditor: lokale Entwürfe (cards/book-editor/drafts.js) und Laden ohne Netz
// (cards/book-editor/blocks.js). Ein ungespeicherter Block muss Schliessen und
// Neuladen überstehen, beim Laden mit SEINER Basis zurückkommen (damit der Save
// gegen den Server-Stand mergt statt still zu überschreiben), und solange der
// Bucheditor ihn hält, darf die Outbox ihn nicht anfassen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key(i) { return [...store.keys()][i] ?? null; },
  getItem(k) { return store.has(k) ? store.get(k) : null; },
  setItem(k, v) { store.set(k, String(v)); },
  removeItem(k) { store.delete(k); },
  clear() { store.clear(); },
};
globalThis.sessionStorage = globalThis.sessionStorage || {
  _m: new Map(),
  getItem(k) { return this._m.get(k) ?? null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};
const statusCalls = [];
// linkedom: der Save-Cleaner (stripLektoratMarks/isNoChange) parst HTML.
const { window: dom } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = dom;
globalThis.document = dom.document;
globalThis.DOMParser = class {
  parseFromString(html) { return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document; }
};
Object.assign(globalThis.window, {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  __app: { t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k), setStatus: (...a) => statusCalls.push(a) },
});

const { readDraft, writeDraft, clearDraft } = await import('../../public/js/editor/draft-storage.js');
const { setLiveEditPages, isLiveEditedHere } = await import('../../public/js/editor/live-edit.js');
const { bookEditorDraftMethods } = await import('../../public/js/cards/book-editor/drafts.js');
const { pageMetasFromTree, isOfflineError, loadContentsFromCache, fetchBookContents } = await import('../../public/js/cards/book-editor/blocks.js');
const { listDraftBackups } = await import('../../public/js/editor/draft-storage.js');
const { contentRepo } = await import('../../public/js/repo/content.js');
const { createTimerBag } = await import('../../public/js/editor/shared/timers.js');

const page = (id, extra = {}) => ({
  kind: 'page', pageId: id, name: 'P' + id, html: '<p data-bid="a1">x</p>', originalHtml: '<p data-bid="a1">x</p>',
  originalUpdatedAt: 'T0', dirty: false, saving: false, saveError: '', conflict: null, savedAt: null,
  offline: false, draftFailed: false, _rev: 0, ...extra,
});

function ctx(blocks) {
  const enqueued = [];
  return Object.assign(Object.create(bookEditorDraftMethods), {
    blocks, offlineSource: false, activePageId: null,
    _draftTimers: createTimerBag(),
    _syncBlockIds: () => {},
    _enqueueSave: (id) => enqueued.push(id),
    get dirtyCount() { return blocks.filter((b) => b.dirty).length; },
    enqueued,
  });
}

test('Entwurf trägt Basis und Schreiber `book`; gespeichert → geräumt', () => {
  store.clear();
  const b = page(1, { dirty: true, html: '<p data-bid="a1">neu</p>' });
  const c = ctx([b]);
  c._writeBlockDraft(b);
  const d = readDraft(1);
  assert.equal(d.html, '<p data-bid="a1">neu</p>');
  assert.equal(d.originalHtml, '<p data-bid="a1">x</p>');
  assert.equal(d.originalUpdatedAt, 'T0');
  assert.equal(d.writer, 'book');
  b.dirty = false;
  c._writeBlockDraft(b);
  assert.equal(readDraft(1), null);
});

test('unveränderter Block schreibt keinen Entwurf', () => {
  store.clear();
  const b = page(2, { dirty: true });
  ctx([b])._writeBlockDraft(b);
  assert.equal(readDraft(2), null);
});

test('Speicher voll → draftFailed am Block', () => {
  store.clear();
  const b = page(3, { dirty: true, html: '<p data-bid="a1">neu</p>' });
  const orig = localStorage.setItem;
  localStorage.setItem = () => { throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); };
  try { ctx([b])._writeBlockDraft(b); } finally { localStorage.setItem = orig; }
  assert.equal(b.draftFailed, true);
});

test('Wiederherstellen: Entwurf kommt mit SEINER Basis zurück und wird gespeichert', () => {
  store.clear();
  statusCalls.length = 0;
  writeDraft(4, '<p data-bid="a1">lokal</p>', '<p data-bid="a1">alt</p>', 'T-alt', { writer: 'book' });
  const b = page(4, { html: '<p data-bid="a1">server</p>', originalHtml: '<p data-bid="a1">server</p>', originalUpdatedAt: 'T-neu' });
  const c = ctx([b]);
  c._restoreBlockDrafts();
  assert.equal(b.html, '<p data-bid="a1">lokal</p>');
  assert.equal(b.originalHtml, '<p data-bid="a1">alt</p>', 'Basis des Merges ist die Entwurfs-Basis');
  assert.equal(b.originalUpdatedAt, 'T-alt', 'der Save läuft so in den Pre-Check-Merge');
  assert.equal(b.dirty, true);
  assert.deepEqual(c.enqueued, [4]);
  assert.match(statusCalls[0][0], /bookEditor\.draftsRestored/);
});

test('Wiederherstellen: Entwurf = Server-Stand → geräumt, Block bleibt sauber', () => {
  store.clear();
  writeDraft(5, '<p data-bid="a1">x</p>', '<p data-bid="a1">alt</p>', 'T-alt', { writer: 'book' });
  const b = page(5);
  ctx([b])._restoreBlockDrafts();
  assert.equal(b.dirty, false);
  assert.equal(readDraft(5), null);
});

test('Wiederherstellen: Alt-Entwurf ohne Stempel bleibt dem Notebook-Banner', () => {
  store.clear();
  writeDraft(6, '<p>lokal</p>', '<p>alt</p>', null);
  const b = page(6);
  ctx([b])._restoreBlockDrafts();
  assert.equal(b.dirty, false);
  assert.ok(readDraft(6), 'Entwurf bleibt liegen');
});

test('Wiederherstellen: Abschnitt live in diesem Tab (Notebook) → nicht angefasst', () => {
  store.clear();
  writeDraft(7, '<p>lokal</p>', '<p>alt</p>', 'T-alt');
  setLiveEditPages('notebook', [7]);
  const b = page(7);
  ctx([b])._restoreBlockDrafts();
  setLiveEditPages('notebook', []);
  assert.equal(b.dirty, false);
});

test('gehaltene Blöcke: dirty, speichernd, Konflikt', () => {
  const c = ctx([page(1, { dirty: true }), page(2), page(3, { saving: true }), page(4, { conflict: {} }), { kind: 'chapter' }]);
  assert.deepEqual(c._heldPageIds(), [1, 3, 4]);
  setLiveEditPages('book', c._heldPageIds());
  assert.equal(isLiveEditedHere(3), true);
  assert.equal(isLiveEditedHere(2), false);
  setLiveEditPages('book', []);
  assert.equal(isLiveEditedHere(3), false);
});

test('Online-Retry speichert nur offline gescheiterte Blöcke ohne Konflikt', () => {
  const c = ctx([page(1, { dirty: true, offline: true }), page(2, { dirty: true }), page(3, { dirty: true, offline: true, conflict: {} })]);
  c._retryOfflineBlocks();
  assert.deepEqual(c.enqueued, [1]);
});

test('Outbox: vom Bucheditor dieses Tabs gehaltener Abschnitt → skip, kein PUT', async () => {
  store.clear();
  const { appOutboxMethods } = await import('../../public/js/app/app-outbox.js');
  writeDraft(8, '<p>lokal</p>', '<p>basis</p>', 'T0', { writer: 'book' });
  setLiveEditPages('book', [8]);
  let puts = 0;
  const orig = contentRepo.savePage;
  contentRepo.savePage = async () => { puts++; return {}; };
  const box = Object.assign(Object.create(appOutboxMethods), {
    editMode: false, currentPage: null, conflictResolution: null, _pageNameById: () => 'A',
  });
  try { assert.equal(await box._flushOneDraft(8), 'skip'); }
  finally { contentRepo.savePage = orig; setLiveEditPages('book', []); clearDraft(8); }
  assert.equal(puts, 0);
});

test('Lesereihenfolge offline = Server: Abschnitte ohne Kapitel zuerst, dann Kapitel depth-first', () => {
  const tree = {
    chapters: [
      { id: 10, name: 'K1', pages: [{ id: 1 }], subchapters: [{ id: 11, name: 'K1.1', pages: [{ id: 2 }], subchapters: [] }] },
      { id: 20, name: 'K2', pages: [{ id: 3 }], subchapters: [] },
    ],
    topPages: [{ id: 9 }],
  };
  assert.deepEqual(pageMetasFromTree(tree).map((m) => [m.id, m.chapterId]), [[9, null], [1, 10], [2, 11], [3, 20]]);
});

test('isOfflineError: Netzfehler und SW-503 «offline», nicht aber Server-Fehler', () => {
  assert.equal(isOfflineError({ status: 0 }), true);
  assert.equal(isOfflineError(new TypeError('fetch')), true);
  assert.equal(isOfflineError({ status: 503, body: { error: 'offline' } }), true);
  assert.equal(isOfflineError({ status: 503, body: null }), false);
  assert.equal(isOfflineError({ status: 409 }), false);
  assert.equal(isOfflineError(Object.assign(new Error('content timeout'), { name: 'TimeoutError' })), true);
  assert.equal(isOfflineError(new Error('merge kaputt')), false, 'ein echter Fehler ist nicht „offline"');
});

test('loadContentsFromCache: fehlende Abschnitte zählen als missing', async () => {
  const origTree = contentRepo.bookTree;
  const origPage = contentRepo.loadPage;
  contentRepo.bookTree = async () => ({ chapters: [{ id: 10, name: 'K', pages: [{ id: 1 }, { id: 2 }], subchapters: [] }], topPages: [] });
  contentRepo.loadPage = async (id) => {
    if (id === 2) throw new TypeError('offline');
    return { id, name: 'A' + id, html: '<p>h</p>', updated_at: 'T' + id };
  };
  try {
    const data = await loadContentsFromCache(5);
    assert.equal(data.missing, 1);
    assert.deepEqual(data.pages, [{ pageId: 1, pageName: 'A1', chapterId: 10, chapterName: 'K', html: '<p>h</p>', updated_at: 'T1' }]);
  } finally { contentRepo.bookTree = origTree; contentRepo.loadPage = origPage; }
});

test('Wiederherstellen: Save-Kennungen des Entwurfs gehen an den Block (verlorene Antwort nach Neustart bleibt „eigen")', () => {
  store.clear();
  writeDraft(40, '<p data-bid="a1">lokal</p>', '<p data-bid="a1">alt</p>', 'T-alt', { writer: 'book' });
  const d = JSON.parse(store.get('editor_draft_40'));
  d.ownSaveIds = [{ id: 's1', base: 'T-alt' }];
  store.set('editor_draft_40', JSON.stringify(d));
  const b = page(40, { html: '<p data-bid="a1">server</p>', originalHtml: '<p data-bid="a1">server</p>' });
  ctx([b])._restoreBlockDrafts();
  assert.deepEqual(b._draftOwn, [{ id: 's1', base: 'T-alt' }]);
});

test('Wiederherstellen ein zweites Mal (spätes IndexedDB): bearbeitete Blöcke unberührt, Entwurf nicht geräumt', () => {
  store.clear();
  writeDraft(41, '<p data-bid="a1">lokal</p>', '<p data-bid="a1">alt</p>', 'T-alt', { writer: 'book' });
  const b = page(41, { html: '<p data-bid="a1">server</p>', originalHtml: '<p data-bid="a1">server</p>' });
  const c = ctx([b]);
  c._restoreBlockDrafts();
  c._restoreBlockDrafts({ late: true });
  assert.equal(b.html, '<p data-bid="a1">lokal</p>');
  assert.ok(readDraft(41), 'der zweite Lauf hält den gesetzten Stand nicht für „schon gespeichert"');
});

test('Spät geladener Entwurf trifft den aktiven, unveränderten Block → Sicherung statt DOM-Tausch', () => {
  store.clear();
  writeDraft(42, '<p data-bid="a1">offline</p>', '<p data-bid="a1">alt</p>', 'T-alt', { writer: 'book' });
  const b = page(42, { html: '<p data-bid="a1">server</p>', originalHtml: '<p data-bid="a1">server</p>' });
  const c = ctx([b]);
  c.activePageId = 42;
  c._restoreBlockDrafts({ late: true });
  assert.equal(b.dirty, false);
  assert.equal(readDraft(42), null);
  assert.ok(listDraftBackups().some((x) => x.pageId === 42 && x.kind === 'recovered'));
});

test('fetchBookContents: Rückfall aus der SW-Ablage → je Abschnitt der jüngere Stand, offline markiert', async () => {
  const origTree = contentRepo.bookTree;
  const origPage = contentRepo.loadPage;
  const origFetch = globalThis.fetch;
  contentRepo.bookTree = async () => ({ chapters: [{ id: 10, name: 'K', pages: [{ id: 1 }, { id: 2 }], subchapters: [] }], topPages: [] });
  contentRepo.loadPage = async (id) => {
    if (id === 1) return { id, name: 'A1', html: '<p>neu gespeichert</p>', updated_at: '2026-10-18T10:00:00Z' };
    throw new TypeError('nicht im Cache');
  };
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    headers: { get: (k) => (k === 'X-SW-Fallback' ? 'domain' : null) },
    json: async () => ({ bookId: 5, pages: [
      { pageId: 1, pageName: 'A1', chapterId: 10, html: '<p>alt</p>', updated_at: '2026-10-18T08:00:00Z' },
      { pageId: 2, pageName: 'A2', chapterId: 10, html: '<p>nur hier</p>', updated_at: '2026-10-18T08:00:00Z' },
    ] }),
  });
  try {
    const data = await fetchBookContents(5);
    assert.equal(data.offline, true);
    assert.deepEqual(data.pages.map((p) => p.html), ['<p>neu gespeichert</p>', '<p>nur hier</p>']);
    assert.equal(data.missing, 0);
  } finally { contentRepo.bookTree = origTree; contentRepo.loadPage = origPage; globalThis.fetch = origFetch; }
});

test('fetchBookContents: echte Server-Antwort bleibt unverändert', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ bookId: 5, pages: [] }) });
  try { assert.deepEqual(await fetchBookContents(5), { bookId: 5, pages: [] }); }
  finally { globalThis.fetch = origFetch; }
});
