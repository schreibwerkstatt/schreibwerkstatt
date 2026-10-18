// Reconnect-Outbox (app/app-outbox.js): Entwürfe nachsenden, ohne Text zu
// verlieren und ohne an einer anderen Warteschlange zu hängen.
//
// DIE INVARIANTEN:
//   1. Gesendet → nur der gesendete Stand fällt; hat ein Tab während des PUT
//      weitergeschrieben, bleibt dessen neuerer Entwurf.
//   2. Abschnitt gibt es nicht mehr (404) → Entwurf wird Sicherung, zählt nicht
//      mehr als wartend.
//   3. Entwurf eines anderen Buchs → Name vom Server, wird gesendet (nicht bis
//      zum nächsten Öffnen liegen gelassen).
//   4. Klemmt die Struktur- oder Ideen-Warteschlange (5xx), gehen die Entwürfe
//      trotzdem; nur „Netz weg" hält alles an.
//   5. Ein offline angelegter Abschnitt ohne Kapitel erscheint nach einem
//      Neuladen ohne Netz im Baum.
import { test } from 'node:test';
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
globalThis.window = globalThis.window || { dispatchEvent: () => true, addEventListener: () => {} };
globalThis.Alpine = { store: () => ({ selectedBookId: 7 }) };

const { readDraft, writeDraft, listDraftPageIds, listDraftBackups } = await import('../../public/js/editor/draft-storage.js');
const { appOutboxMethods } = await import('../../public/js/app/app-outbox.js');
const { contentRepo } = await import('../../public/js/repo/content.js');
const S = await import('../../public/js/repo/structure-queue.js');

const statuses = [];
function box(extra = {}) {
  return Object.assign(Object.create(appOutboxMethods), {
    editMode: false, currentPage: null, conflictResolution: null,
    $store: { nav: { pages: [{ id: 1, name: 'Eins' }], tree: [] }, session: { pendingSyncCount: 0 } },
    t: (k) => k, setStatus: (...a) => statuses.push(a), _refreshRescueCount: () => {},
    ...extra,
  });
}

function withRepo(over, fn) {
  const orig = {};
  for (const k of Object.keys(over)) { orig[k] = contentRepo[k]; contentRepo[k] = over[k]; }
  return Promise.resolve().then(fn).finally(() => { for (const k of Object.keys(over)) contentRepo[k] = orig[k]; });
}

test.beforeEach(() => { ls.clear(); statuses.length = 0; });

test('gesendet, aber währenddessen weitergeschrieben: der neuere Entwurf bleibt', async () => {
  writeDraft(1, '<p>a</p>', '<p>b</p>', 'T0');
  await withRepo({
    savePage: async () => {
      await new Promise((r) => setTimeout(r, 2));
      writeDraft(1, '<p>a + mehr</p>', '<p>b</p>', 'T0'); // anderer Tab tippt
      return { id: 1, updated_at: 'T1' };
    },
  }, async () => {
    assert.equal(await box()._flushOneDraft(1), 'ok');
  });
  assert.equal(readDraft(1)?.html, '<p>a + mehr</p>');
});

test('gesendet ohne Zwischenstand: Entwurf fällt', async () => {
  writeDraft(1, '<p>a</p>', '<p>b</p>', 'T0');
  await withRepo({ savePage: async () => ({ id: 1, updated_at: 'T1' }) }, async () => {
    assert.equal(await box()._flushOneDraft(1), 'ok');
  });
  assert.equal(readDraft(1), null);
});

test('Abschnitt gelöscht (404): Entwurf wird Sicherung, nicht mehr wartend', async () => {
  writeDraft(1, '<p>a</p>', '<p>b</p>', 'T0');
  await withRepo({ savePage: async () => { throw Object.assign(new Error('x'), { status: 404 }); } }, async () => {
    assert.equal(await box()._flushOneDraft(1), 'orphan');
  });
  assert.deepEqual(listDraftPageIds(), []);
  assert.equal(listDraftBackups()[0]?.kind, 'orphan');
});

test('Entwurf eines anderen Buchs: Name vom Server, wird gesendet', async () => {
  writeDraft(55, '<p>a</p>', '<p>b</p>', 'T0');
  const saved = [];
  await withRepo({
    loadPage: async (id) => ({ id, name: 'Fremd', html: '<p>b</p>', updated_at: 'T0' }),
    savePage: async (id, body) => { saved.push([id, body.name]); return { id, updated_at: 'T1' }; },
  }, async () => {
    assert.equal(await box()._flushOneDraft(55), 'ok');
  });
  assert.deepEqual(saved, [[55, 'Fremd']]);
});

test('Entwurf eines anderswo gelöschten Abschnitts (anderes Buch): Sicherung', async () => {
  writeDraft(56, '<p>a</p>', '<p>b</p>', 'T0');
  await withRepo({ loadPage: async () => { throw Object.assign(new Error('x'), { status: 404 }); } }, async () => {
    assert.equal(await box()._flushOneDraft(56), 'orphan');
  });
  assert.deepEqual(listDraftPageIds(), []);
});

test('5xx beim Entwurf: „retry" (Backoff), die übrigen laufen weiter', async () => {
  writeDraft(1, '<p>a</p>', '<p>b</p>', 'T0');
  await withRepo({ savePage: async () => { throw Object.assign(new Error('x'), { status: 502 }); } }, async () => {
    assert.equal(await box()._flushOneDraft(1), 'retry');
  });
  assert.ok(readDraft(1));
});

test('Struktur-Warteschlange klemmt (5xx): Entwürfe gehen trotzdem', async () => {
  S.setStructureOwner(null);
  S.queueRename('page', 1, 'X', { bookId: 7 });
  writeDraft(1, '<p>a</p>', '<p>b</p>', 'T0');
  const calls = [];
  const b = box({
    _applyTempPageRemaps: () => {}, _reportStructureResult: () => {}, loadPages: () => {},
    _flushIdeenInto: async () => null, _scheduleOutboxRetry: () => calls.push('backoff'),
    _reportOutboxResults: () => {}, _refreshPendingSyncCount: () => {},
  });
  await withRepo({
    sendQueuedStructureOp: async () => { throw Object.assign(new Error('x'), { status: 503 }); },
    savePage: async (id) => { calls.push('save:' + id); return { id, updated_at: 'T1' }; },
  }, () => b._flushOutbox());
  assert.ok(calls.includes('save:1'), calls.join(','));
  assert.ok(calls.includes('backoff'), 'Struktur wird später erneut versucht');
  S.dropQueuedRename('page', 1);
});

test('Offline angelegter Abschnitt ohne Kapitel erscheint nach dem Neuladen im Baum', () => {
  S.setStructureOwner(null);
  const p = S.queueCreatePage({ book_id: 7, name: 'Solo', html: '<p>x</p>' }, { bookId: 7 });
  const nav = { pages: [{ id: 3, name: 'K-Abschnitt', chapter_id: 10 }], tree: [{ type: 'chapter', id: 10, solo: false, pages: [] }] };
  const b = box({ $store: { nav }, _bumpTreeRev: () => {}, _rebuildTreeOrderMaps: () => {}, _findTreeChapter: () => null });
  b._overlayPendingStructure(7);
  assert.equal(nav.pages[0].id, p.id, 'vor den Kapitel-Abschnitten');
  assert.equal(nav.tree[0].solo, true);
  assert.equal(nav.tree[0].pages[0].name, 'Solo');
  S.dropPendingPage(p.id);
});
