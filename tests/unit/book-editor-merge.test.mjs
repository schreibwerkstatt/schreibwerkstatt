// Bucheditor: Block-Level-Merge bei Stale-Write (cards/book-editor/conflict.js).
// Merge-Plan (pure) und die Zustandsübergänge am Block: still gemergt →
// Basis = Server-Stand, Block dirty; Kollision → Modal-State; Auflösung →
// aufgelöster Stand + Save. DOM-Pfade (aktiver Block, Caret) deckt
// tests/e2e-app/book-editor-merge.spec.js gegen die echte App ab.

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {} };

const { planBlockMerge, bookEditorConflictMethods } = await import('../../public/js/cards/book-editor/conflict.js');

const P = (bid, text) => `<p data-bid="${bid}">${text}</p>`;
const BASE = P('a1', 'Eins.') + P('a2', 'Zwei.') + P('a3', 'Drei.');

test('planBlockMerge: verschiedene Absätze → clean, beide Änderungen drin', () => {
  const local = P('a1', 'Eins lokal.') + P('a2', 'Zwei.') + P('a3', 'Drei.');
  const remote = P('a1', 'Eins.') + P('a2', 'Zwei.') + P('a3', 'Drei remote.');
  const plan = planBlockMerge(BASE, local, remote, { enabled: true });
  assert.equal(plan.kind, 'clean');
  assert.equal(plan.html, P('a1', 'Eins lokal.') + P('a2', 'Zwei.') + P('a3', 'Drei remote.'));
});

test('planBlockMerge: derselbe Absatz → collision mit genau dieser Stelle', () => {
  const local = P('a1', 'Eins.') + P('a2', 'Zwei lokal.') + P('a3', 'Drei.');
  const remote = P('a1', 'Eins remote.') + P('a2', 'Zwei remote.') + P('a3', 'Drei.');
  const plan = planBlockMerge(BASE, local, remote, { enabled: true });
  assert.equal(plan.kind, 'collision');
  assert.deepEqual(plan.conflicts.map((c) => c.bid), ['a2']);
});

test('planBlockMerge: Basis ohne Block-IDs oder Flag aus → fallback', () => {
  assert.equal(planBlockMerge('<p>x</p>', '<p>y</p>', '<p>z</p>', { enabled: true }).kind, 'fallback');
  assert.equal(planBlockMerge(BASE, BASE, BASE, { enabled: false }).kind, 'fallback');
});

// Minimaler Card-Scope, inaktiver Block (kein DOM).
function ctxFor(block) {
  const enqueued = [];
  const ctx = {
    ...bookEditorConflictMethods,
    activePageId: null,
    conflictResolution: null,
    _autosave: { clear: () => {} },
    _syncBlockIds: () => {},
    _historyDrop: () => {},
    _blockById: (id) => (id === block.pageId ? block : null),
    _blockEl: () => null,
    _conflictText: () => 'Konflikt',
    _enqueueSave: (id) => enqueued.push(id),
  };
  return { ctx, enqueued };
}

const blockWith = (html) => ({
  kind: 'page', pageId: 7, html, originalHtml: BASE, originalUpdatedAt: 'T0',
  dirty: true, saving: false, saveError: '', conflict: null, _rev: 0,
});

test('_mergeStaleBlock: kollisionsfrei → Basis = Server-Stand, Block dirty, Re-Hydrate', () => {
  const block = blockWith(P('a1', 'Eins lokal.') + P('a2', 'Zwei.') + P('a3', 'Drei.'));
  const { ctx } = ctxFor(block);
  const remoteHtml = P('a1', 'Eins.') + P('a2', 'Zwei remote.') + P('a3', 'Drei.');
  const r = ctx._mergeStaleBlock(block, { remoteHtml, remoteUpdatedAt: 'T5', remoteIsSelf: true, remoteDevice: 'Mac' });
  assert.equal(r, 'merged');
  assert.equal(block.html, P('a1', 'Eins lokal.') + P('a2', 'Zwei remote.') + P('a3', 'Drei.'));
  assert.equal(block.originalHtml, remoteHtml, 'nächster Merge rechnet gegen den Server-Stand');
  assert.equal(block.originalUpdatedAt, 'T5', 'der Save läuft gegen den neuen Stempel');
  assert.equal(block.dirty, true);
  assert.equal(block.conflict, null);
  assert.equal(block._rev, 1);
  assert.equal(ctx.conflictResolution, null);
});

test('_mergeStaleBlock: Kollision → Banner + Modal, Basis bleibt bis zur Auflösung', () => {
  const block = blockWith(P('a1', 'Eins.') + P('a2', 'Zwei lokal.') + P('a3', 'Drei.') + '<p>Neu lokal.</p>');
  const { ctx, enqueued } = ctxFor(block);
  const remoteHtml = P('a1', 'Eins remote.') + P('a2', 'Zwei remote.') + P('a3', 'Drei.');
  const r = ctx._mergeStaleBlock(block, { remoteHtml, remoteUpdatedAt: 'T6', remoteIsSelf: false, remoteUserName: 'Bea' });
  assert.equal(r, 'conflict');
  assert.equal(block.conflict.mergeable, true);
  assert.equal(block.originalUpdatedAt, 'T0');
  assert.equal(ctx.conflictResolution.pageId, 7);
  assert.deepEqual(ctx.conflictResolution.conflicts.map((c) => c.bid), ['a2']);
  assert.ok(ctx.conflictResolution.conflicts[0].view, 'Diff-Ansicht fürs Modal');

  ctx.resolveBookConflictBlock('a2', 'both');
  ctx.submitBookConflict();
  assert.equal(ctx.conflictResolution, null);
  assert.equal(block.html,
    P('a1', 'Eins remote.') + P('a2', 'Zwei lokal.') + P('a2', 'Zwei remote.') + P('a3', 'Drei.') + '<p>Neu lokal.</p>');
  assert.equal(block.originalHtml, remoteHtml);
  assert.equal(block.originalUpdatedAt, 'T6');
  assert.equal(block.conflict, null);
  assert.equal(block.dirty, true);
  assert.deepEqual(enqueued, [7]);
});

test('_mergeStaleBlock: ein offenes Modal einer anderen Seite wird nicht ersetzt', () => {
  const block = blockWith(P('a1', 'Eins.') + P('a2', 'Zwei lokal.') + P('a3', 'Drei.'));
  const { ctx } = ctxFor(block);
  ctx.conflictResolution = { pageId: 99, decisions: {}, conflicts: [] };
  const r = ctx._mergeStaleBlock(block, { remoteHtml: P('a1', 'Eins.') + P('a2', 'Zwei remote.') + P('a3', 'Drei.'), remoteUpdatedAt: 'T7' });
  assert.equal(r, 'conflict');
  assert.equal(ctx.conflictResolution.pageId, 99);
  assert.ok(block.conflict, 'Banner mit «Konflikt lösen …»');
});

test('_mergeStaleBlock: Basis ohne IDs → fallback, Banner bietet Überschreiben', () => {
  const block = { ...blockWith('<p>lokal</p>'), originalHtml: '<p>alt</p>' };
  const { ctx } = ctxFor(block);
  const r = ctx._mergeStaleBlock(block, { remoteHtml: '<p>remote</p>', remoteUpdatedAt: 'T8' });
  assert.equal(r, 'fallback');
  assert.equal(block.conflict.mergeable, false);
  assert.equal(ctx.conflictResolution, null);
});
