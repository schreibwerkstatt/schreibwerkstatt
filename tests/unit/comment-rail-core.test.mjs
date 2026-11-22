// Geteilter Kern der zwei SPA-Kommentar-Leisten (comment-rail-core.js) —
// Konsumenten: Notebook-Leseansicht (editor/comments-rail.js) und Bucheditor
// (editor/book-editor-comments.js). Gegenstand hier sind die Lifecycle-Kanten:
// Load-Race, Recompute-Scheduling nach Abbruch, Recompute nach Resolve und
// sichtbare Fehler bei Reply/Resolve/Delete.

import test from 'node:test';
import assert from 'node:assert/strict';

// ── Stubs ────────────────────────────────────────────────────────────────────
const statusCalls = [];
globalThis.window = globalThis.window || {};
window.__app = {
  t: (k) => k,
  setStatus: (...a) => statusCalls.push(a),
  appConfirm: async () => true,
};
globalThis.Alpine = { store: () => ({ selectedBookId: 7 }) };

// rAF/setTimeout als manuelle Queues: der Test fährt die Frames selbst.
let rafQ = new Map(); let rafId = 0;
let toQ = new Map(); let toId = 0;
globalThis.requestAnimationFrame = (fn) => { rafQ.set(++rafId, fn); return rafId; };
globalThis.cancelAnimationFrame = (id) => { rafQ.delete(id); };
globalThis.setTimeout = (fn) => { toQ.set(++toId, fn); return toId; };
globalThis.clearTimeout = (id) => { toQ.delete(id); };
function flushFrames(rounds = 50) {
  for (let i = 0; i < rounds; i++) {
    const r = [...rafQ.values()]; rafQ.clear();
    const t = [...toQ.values()]; toQ.clear();
    if (!r.length && !t.length) return;
    r.forEach(fn => fn()); t.forEach(fn => fn());
  }
}

let fetchImpl = async () => ({ ok: true, status: 200, json: async () => [] });
globalThis.fetch = (...a) => fetchImpl(...a);

const { createCommentRail } = await import('../../public/js/editor/comment-rail-core.js');

function makeCtx({ shouldWait = () => false } = {}) {
  const rail = createCommentRail({
    scopeEl: () => null,
    hlAll: 'a', hlActive: 'b',
    keys: {
      comments: 'comments', threads: 'threads', selectedRootId: 'sel', railVisible: 'visible',
      replyDrafts: 'drafts', savingReply: 'savingReply', savingResolve: 'savingResolve',
      loadingBookId: 'loadingBookId', recomputeRaf: 'raf',
    },
    idle: () => false,
    shouldWait,
    scrollToRange: () => {},
  });
  const ctx = {
    comments: [], threads: [], sel: null, visible: true, drafts: {},
    savingReply: null, savingResolve: null, loadingBookId: null, raf: null,
    ...rail,
  };
  ctx.recomputes = 0;
  const orig = ctx._railRecompute;
  ctx._railRecompute = function () { this.recomputes++; return orig.call(this); };
  return ctx;
}

test('_railLoad: später Fehler eines entwerteten Loads leert die Liste nicht', async () => {
  const ctx = makeCtx();
  let reject;
  fetchImpl = () => new Promise((_, r) => { reject = r; });
  const pending = ctx._railLoad(1);
  ctx._railInvalidateLoad();              // view:reset / Buchwechsel
  ctx.comments = [{ id: 99 }];            // Stand des neuen Buchs
  reject(new Error('net'));
  await pending;
  assert.deepEqual(ctx.comments, [{ id: 99 }]);
});

test('_railLoad ohne Buch setzt loadingBookId zurück', async () => {
  const ctx = makeCtx();
  ctx.loadingBookId = 5;
  const store = globalThis.Alpine.store;
  globalThis.Alpine.store = () => ({ selectedBookId: null });
  await ctx._railLoad(null);
  globalThis.Alpine.store = store;
  assert.equal(ctx.loadingBookId, null);
});

test('_railSchedule: Abbruch stoppt auch eine wartende Retry-Kette', () => {
  let waiting = true;
  const ctx = makeCtx({ shouldWait: () => waiting });
  ctx._railSchedule();
  // Kette läuft in den inneren setTimeout.
  [...rafQ.values()].forEach(fn => fn()); rafQ.clear();
  [...rafQ.values()].forEach(fn => fn()); rafQ.clear();
  ctx._railCancelSchedule();              // destroy()
  waiting = false;
  flushFrames();
  assert.equal(ctx.recomputes, 0, 'kein Recompute nach Abbruch');
});

test('_railSchedule: erneutes Schedulen ersetzt die Kette statt eine zweite zu starten', () => {
  let waiting = true;
  const ctx = makeCtx({ shouldWait: () => waiting });
  ctx._railSchedule();
  [...rafQ.values()].forEach(fn => fn()); rafQ.clear();
  ctx._railSchedule();
  waiting = false;
  flushFrames();
  assert.equal(ctx.recomputes, 1);
});

test('_railResolve: Erfolg löst neu auf (Highlight/Filter aktuell)', async () => {
  const ctx = makeCtx();
  fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({}) });
  const c = { id: 3, resolved_at: null };
  await ctx._railResolve(c);
  assert.ok(c.resolved_at);
  assert.equal(ctx.recomputes, 1);
});

test('Reply/Resolve/Delete: Fehler landet sichtbar in der Statuszeile', async () => {
  const ctx = makeCtx();
  fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  statusCalls.length = 0;
  ctx.drafts = { 1: 'Hallo' };
  await ctx._railReply({ root: { id: 1, share_token: 'tok' } });
  await ctx._railResolve({ id: 2, resolved_at: null });
  await ctx._railDelete({ id: 3 });
  assert.deepEqual(statusCalls.map(a => a[0]), [
    'share.comments.replyFailed', 'share.comments.resolveFailed', 'share.comments.deleteFailed',
  ]);
  assert.equal(ctx.drafts[1], 'Hallo', 'Entwurf bleibt nach Fehler stehen');
});

// ── Zähler, Filter, Sprung ───────────────────────────────────────────────────
// Echter DOM (linkedom) für locateRange/rangeFromOffsets.
const { parseHTML } = await import('linkedom');

function railWithDom(html, extraKeys = {}) {
  const { document: doc, NodeFilter: NF } = parseHTML(`<html><body><div id="v">${html}</div></body></html>`);
  // linkedom hat kein vollständiges Range — Geometrie braucht der Test nicht.
  doc.createRange = () => ({ setStart() {}, setEnd() {}, isPointInRange: () => false });
  globalThis.document = doc;
  globalThis.NodeFilter = NF || { SHOW_TEXT: 4 };
  globalThis.CSS = globalThis.CSS || { escape: (s) => String(s) };
  globalThis.Highlight = globalThis.Highlight || class {};
  const view = doc.getElementById('v');
  const selected = [];
  const rail = createCommentRail({
    scopeEl: () => view,
    hlAll: 'a', hlActive: 'b',
    keys: {
      comments: 'comments', threads: 'threads', selectedRootId: 'sel', railVisible: 'visible',
      replyDrafts: 'drafts', savingReply: 'savingReply', savingResolve: 'savingResolve',
      loadingBookId: 'loadingBookId', recomputeRaf: 'raf', generalThreads: 'general',
      filterStatus: 'fStatus', filterReviewer: 'fReviewer', totalCount: 'total', openCount: 'open',
      pendingGotoToken: 'gotoToken', ...extraKeys,
    },
    generalFilter: () => true,
    idle: () => false,
    shouldWait: () => false,
    scrollToRange: () => {},
  });
  const ctx = {
    comments: [], threads: [], general: [], sel: null, visible: true, drafts: {},
    savingReply: null, savingResolve: null, loadingBookId: null, raf: null,
    fStatus: 'all', fReviewer: '', total: 0, open: 0, gotoToken: null, ...rail,
  };
  const origSelect = ctx._railSelect;
  ctx._railSelect = function (id) { selected.push(id); return origSelect.call(this, id); };
  return { ctx, selected };
}

const DOM = '<p data-bid="b1">Erster Absatz mit Anna.</p><p data-bid="b2">Zweiter Absatz mit Beat.</p>';
const ROWS = [
  { id: 1, share_token: 'L1', anchor_bid: 'b2', anchor_quote: 'Beat', reader_name: 'Carla', created_at: '2026-01-01' },
  { id: 2, share_token: 'L1', anchor_bid: 'b1', anchor_quote: 'Anna', reader_name: 'Carla', created_at: '2026-01-02', resolved_at: '2026-01-03' },
  { id: 3, share_token: 'L2', anchor_bid: 'b1', anchor_quote: 'Erster', reader_name: 'Dora', created_at: '2026-01-04' },
  { id: 4, share_token: 'L2', reader_name: 'Dora', body: 'allgemein', created_at: '2026-01-05' },
];

test('Zähler ungefiltert: ein Filter ohne Treffer lässt total/open stehen', () => {
  const { ctx } = railWithDom(DOM);
  ctx.comments = ROWS;
  ctx._railRecompute();
  assert.equal(ctx.total, 4);
  assert.equal(ctx.open, 3, 'erledigte zählen nicht als offen');
  ctx._railSetFilter({ status: 'resolved', reviewer: 'Dora' });
  assert.equal(ctx.threads.length + ctx.general.length, 0, 'Filter trifft nichts');
  assert.equal(ctx.total, 4);
  assert.equal(ctx.open, 3);
});

test('_railResetFilter setzt Status und Reviewer zurück', () => {
  const { ctx } = railWithDom(DOM);
  ctx.fStatus = 'open'; ctx.fReviewer = 'Dora';
  ctx._railResetFilter();
  assert.equal(ctx.fStatus, 'all');
  assert.equal(ctx.fReviewer, '');
});

test('Sprung per Link-Token: erster OFFENER verankerter Thread des Links in Dokument-Reihenfolge', () => {
  const { ctx, selected } = railWithDom(DOM);
  ctx.comments = ROWS;
  ctx.gotoToken = 'L1';
  ctx._railRecompute();
  // L1: id 2 (b1, erledigt) liegt vor id 1 (b2, offen) → offen gewinnt.
  assert.deepEqual(selected, [1]);
  assert.equal(ctx.sel, 1);
  assert.equal(ctx.gotoToken, null, 'Sprung wird nur einmal ausgeführt');
});

test('Sprung per Link-Token ohne passenden Thread wählt nichts', () => {
  const { ctx, selected } = railWithDom(DOM);
  ctx.comments = ROWS;
  ctx.gotoToken = 'L-unbekannt';
  ctx._railRecompute();
  assert.deepEqual(selected, []);
  assert.equal(ctx.sel, null);
});
