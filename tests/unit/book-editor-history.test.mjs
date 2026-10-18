// Bucheditor: Undo-Verlauf über einen still gemergten Save
// (cards/book-editor/history.js#_historyRebaseAround + conflict.js#_applyBlockHtml).
// Ein kollisionsfreier Merge hebt den Verlauf auf den Remote-Stand: die eigenen
// Schritte bleiben rückgängig machbar, die fremden Blöcke fallen nie heraus.
// Fixtures sind statische HTML-Literale aus dem Test-Source.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.DOMParser = window.DOMParser;
globalThis.NodeFilter = window.NodeFilter || { SHOW_TEXT: 4 };

const { bookEditorConflictMethods } = await import('../../public/js/cards/book-editor/conflict.js');
const { bookEditorHistoryMethods } = await import('../../public/js/cards/book-editor/history.js');

const P = (bid, text) => `<p data-bid="${bid}">${text}</p>`;
const BASE = P('a1', 'Eins.') + P('a2', 'Zwei.') + P('a3', 'Drei.');

function setup({ active }) {
  const root = window.document.getElementById('root');
  root.innerHTML = '<div data-book-editor-page="7" contenteditable="true"></div>';
  const el = root.firstElementChild;
  el.innerHTML = BASE;
  const block = {
    kind: 'page', pageId: 7, html: BASE, originalHtml: BASE, originalUpdatedAt: 'T0',
    dirty: false, saving: false, saveError: '', conflict: null, _rev: 0,
  };
  const ctx = {
    ...bookEditorConflictMethods,
    ...bookEditorHistoryMethods,
    $root: root,
    activePageId: 7,
    conflictResolution: null,
    commentRailVisible: false,
    _histTick: 0,
    _autosave: { clear: () => {} },
    _syncBlockIds: () => {},
    _writeBlockDraft: () => {},
    _blockById: (id) => (id === 7 ? block : null),
    _conflictText: () => 'Konflikt',
  };
  // Input-Glue wie _onBlockInput: block.html folgt dem aktiven DOM.
  el.addEventListener('input', () => { if (ctx.activePageId === 7) block.html = el.innerHTML; });
  ctx._historyOnActivate(7, el);
  // Eigener Schritt: «Eins» geändert.
  el.innerHTML = P('a1', 'Eins lokal.') + P('a2', 'Zwei.') + P('a3', 'Drei.');
  block.html = el.innerHTML;
  block.dirty = true;
  ctx._historyPushNow(7);
  if (!active) {
    ctx._historyOnDeactivate(7);
    ctx.activePageId = null;
  }
  return { ctx, el, block };
}

const REMOTE = P('a1', 'Eins.') + P('a2', 'Zwei.') + P('a3', 'Drei remote.');

test('aktiver Block: Undo nach stillem Merge nimmt nur den eigenen Schritt zurück', () => {
  const { ctx, el, block } = setup({ active: true });
  assert.equal(ctx._mergeStaleBlock(block, { remoteHtml: REMOTE, remoteUpdatedAt: 'T5' }), 'merged');
  assert.match(el.innerHTML, /Eins lokal\..*Drei remote\./);
  assert.equal(ctx.bookEditorCanUndo(), true, 'Verlauf überlebt den Merge');
  ctx.bookEditorUndo();
  assert.match(el.innerHTML, /Eins\.</, 'eigene Änderung zurückgenommen');
  assert.match(el.innerHTML, /Drei remote\./, 'Remote-Änderung bleibt stehen');
  assert.equal(ctx.bookEditorCanUndo(), false, 'kein Stand hinter dem gehobenen Baseline');
  ctx.bookEditorRedo();
  assert.match(el.innerHTML, /Eins lokal\..*Drei remote\./);
});

test('inaktiver Block: Verlauf wird gehoben, Undo nach Reaktivierung behält Remote', () => {
  const { ctx, el, block } = setup({ active: false });
  assert.equal(ctx._mergeStaleBlock(block, { remoteHtml: REMOTE, remoteUpdatedAt: 'T5' }), 'merged');
  assert.equal(block._rev, 1, 'Re-Hydrate angestossen');
  // Reaktivieren: _maybeRehydrate hätte block.html ins DOM geschrieben.
  el.innerHTML = block.html;
  ctx.activePageId = 7;
  ctx._historyOnActivate(7, el);
  ctx.bookEditorUndo();
  assert.match(el.innerHTML, /Eins\.</);
  assert.match(el.innerHTML, /Drei remote\./);
});

test('älterer Stand kollidiert mit Remote: er fällt samt allem Älteren weg', () => {
  const { ctx, el, block } = setup({ active: true });
  // Zwischenstand mit «Drei» anders, danach wieder zurück — der Live-Stand
  // lässt «Drei» unberührt, der Merge ist also clean.
  el.innerHTML = P('a1', 'Eins lokal.') + P('a2', 'Zwei.') + P('a3', 'Drei alt.');
  ctx._historyPushNow(7);
  el.innerHTML = P('a1', 'Eins lokal!') + P('a2', 'Zwei.') + P('a3', 'Drei.');
  block.html = el.innerHTML;
  ctx._historyPushNow(7);
  assert.equal(ctx._mergeStaleBlock(block, { remoteHtml: REMOTE, remoteUpdatedAt: 'T5' }), 'merged');
  assert.equal(ctx.bookEditorCanUndo(), false, 'der kollidierende Zwischenstand ist nicht übertragbar');
  ctx.bookEditorUndo();
  assert.match(el.innerHTML, /Eins lokal!.*Drei remote\./, 'kein Undo hinter den Merge');
});
