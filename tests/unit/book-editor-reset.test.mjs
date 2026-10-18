// Bucheditor: Buch-/Ansichtswechsel darf ungespeicherte Blöcke nicht verwerfen.
// `_resetSession` speichert zuerst die dirty Blöcke (über die Block-Objekte,
// nicht über `saveQueue`-IDs) und räumt erst danach den Session-State ab.

import test from 'node:test';
import assert from 'node:assert/strict';

let factory = null;
const statusCalls = [];
globalThis.window = globalThis.window || {};
Object.assign(globalThis.window, {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {},
  Alpine: { data: (_name, f) => { factory = f; } },
  __app: {
    showBookEditorCard: false,
    t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k),
    setStatus: (...a) => statusCalls.push(a),
  },
});
globalThis.Alpine = { store: () => ({ selectedBookId: 7 }) };
globalThis.document = globalThis.document || {
  createElement: () => ({ innerHTML: '', querySelectorAll: () => [], querySelector: () => null }),
};

const { registerBookEditorCard } = await import('../../public/js/cards/book-editor-card.js');
const { createAutosaveTimers } = await import('../../public/js/editor/shared/autosave.js');
const { createTimerBag } = await import('../../public/js/editor/shared/timers.js');
registerBookEditorCard();

function makeCard() {
  const card = factory();
  card._autosave = createAutosaveTimers(() => {});
  card._savedFlash = createTimerBag();
  card._clearCommentHL = () => {};
  return card;
}

const page = (id, extra = {}) => ({
  kind: 'page', pageId: id, name: 'P' + id, html: '<p>x</p>', originalHtml: '<p>x</p>',
  dirty: false, saving: false, saveError: '', conflict: null, savedAt: null, _rev: 0, ...extra,
});

test('_resetSession: dirty Blöcke werden gespeichert, bevor blocks geleert wird', async () => {
  const card = makeCard();
  const a = page(1, { dirty: true, html: '<p>neu</p>' });
  const b = page(2);
  card.blocks = [a, b];
  const saved = [];
  card._saveBlock = async (blk) => {
    // Zum Save-Zeitpunkt muss der Block noch in der Karte hängen.
    assert.equal(card.blocks.length, 2);
    saved.push(blk.pageId);
    blk.dirty = false;
  };
  await card._resetSession({ reload: false });
  assert.deepEqual(saved, [1]);
  assert.deepEqual(card.blocks, []);
  card._autosave.clearAll();
});

test('_resetSession: wartet einen laufenden Queue-Durchlauf ab', async () => {
  const card = makeCard();
  const a = page(1, { dirty: true });
  card.blocks = [a];
  const order = [];
  let release;
  card._queueRun = new Promise((r) => { release = r; }).then(() => order.push('queue'));
  card._saveBlock = async (blk) => { order.push('save'); blk.dirty = false; };
  const p = card._resetSession({ reload: false });
  release();
  await p;
  assert.deepEqual(order, ['queue', 'save']);
});

test('_resetSession: nicht speicherbarer Block ohne Entwurf → Warnung', async () => {
  statusCalls.length = 0;
  const card = makeCard();
  card.blocks = [page(1, { dirty: true, draftFailed: true })];
  card._saveBlock = async (blk) => { blk.saveError = 'x'; };
  await card._resetSession({ reload: false });
  assert.equal(statusCalls.length, 1);
  assert.match(statusCalls[0][0], /bookEditor\.unsavedOnSwitch/);
  assert.equal(statusCalls[0][1], true);
});

test('_resetSession: nicht speicherbarer Block mit Entwurf → Hinweis «lokal gesichert»', async () => {
  statusCalls.length = 0;
  const card = makeCard();
  card.blocks = [page(1, { dirty: true })];
  card._saveBlock = async (blk) => { blk.offline = true; };
  await card._resetSession({ reload: false });
  assert.equal(statusCalls.length, 1);
  assert.match(statusCalls[0][0], /bookEditor\.keptAsDraft/);
  assert.equal(statusCalls[0][1], false);
});

test('_resetSession: überholter Wechsel räumt nicht doppelt ab', async () => {
  const card = makeCard();
  card.blocks = [page(1, { dirty: true })];
  card._saveBlock = async (blk) => {
    blk.dirty = false;
    card._loadToken++;          // paralleles _load hat übernommen
    card.blocks = [page(9)];
  };
  await card._resetSession({ reload: false });
  assert.equal(card.blocks.length, 1);
  assert.equal(card.blocks[0].pageId, 9);
});

test('_load über laufender Arbeit (Re-Klick, card:refresh): erst speichern, dann neu aufbauen', async () => {
  const card = makeCard();
  const a = page(1, { dirty: true, html: '<p>neu</p>' });
  card.blocks = [a];
  const order = [];
  card._saveBlock = async (blk) => {
    assert.equal(card.blocks[0], a, 'Block hängt beim Save noch in der Karte');
    order.push('save');
    blk.dirty = false;
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    order.push('fetch');
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ bookId: 7, pages: [] }) };
  };
  card._loadBookComments = () => {};
  card._loadHeads = () => {};
  card.$nextTick = () => {};
  try { await card._load(7); }
  finally { globalThis.fetch = origFetch; card._autosave.clearAll(); }
  assert.deepEqual(order.slice(0, 2), ['save', 'fetch']);
});
