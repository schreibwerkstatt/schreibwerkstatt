// Bucheditor-Save-Pfad (cards/book-editor/save.js): Leer-Schutz, Rückkehr auf
// den Server-Stand und die Bilanz nach «Alle speichern».

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document, window } = parseHTML('<body></body>');
globalThis.document = document;
globalThis.window = globalThis.window || window;
// linkedoms DOMParser scheitert an Fragmenten — wie der Browser ein ganzes
// Dokument um das Fragment bauen.
globalThis.DOMParser = class {
  parseFromString(html) { return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document; }
};
globalThis.window.matchMedia ||= () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });

const { isEmptyManuscript, bookEditorSaveMethods } = await import('../../public/js/cards/book-editor/save.js');

const statuses = [];
globalThis.window.__app = {
  t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
  setStatus: (msg, isError) => statuses.push({ msg, isError }),
};

test('isEmptyManuscript: ohne Text und ohne Bild/Tabelle/Trenner → leer', () => {
  assert.equal(isEmptyManuscript(''), true);
  assert.equal(isEmptyManuscript('<p></p>'), true);
  assert.equal(isEmptyManuscript('<p> </p><p><br></p>'), true);
});

test('isEmptyManuscript: Abschnitt nur mit Bild, Tabelle oder Trennlinie ist nicht leer', () => {
  // Sonst liess sich ein Bild-Abschnitt nach jeder Änderung nicht mehr speichern.
  assert.equal(isEmptyManuscript('<figure><img src="/x.png" alt=""></figure>'), false);
  assert.equal(isEmptyManuscript('<table><tr><td></td></tr></table>'), false);
  assert.equal(isEmptyManuscript('<hr class="pagebreak">'), false);
  assert.equal(isEmptyManuscript('<p>Text</p>'), false);
});

// Minimaler Card-Scope für _saveBlock bis zum No-Change-Ausgang.
function saveCtx() {
  const drafts = [];
  const ctx = {
    ...bookEditorSaveMethods,
    _autosave: { clear: () => {}, schedule: () => {} },
    _syncBlockIds: () => {},
    _writeBlockDraft: (b) => drafts.push(b.pageId),
  };
  return { ctx, drafts };
}

test('_saveBlock: zurück auf dem Server-Stand räumt Leer-Hinweis, offline und Entwurf', async () => {
  // Ablauf: Block geleert → Leer-Schutz; per Undo zurück → Wechsel speichert
  // nicht (No-Change). Der Hinweis darf dann nicht stehen bleiben.
  const { ctx, drafts } = saveCtx();
  const block = {
    kind: 'page', pageId: 3, html: '<p>gleich</p>', originalHtml: '<p>gleich</p>',
    dirty: true, saving: false, conflict: null, offline: true, saveError: 'bookEditor.emptyAbort',
  };
  await ctx._saveBlock(block);
  assert.equal(block.dirty, false);
  assert.equal(block.saveError, '');
  assert.equal(block.offline, false);
  assert.equal(ctx.blockStatus(block), '');
  assert.deepEqual(drafts, [3], 'Entwurf wird geräumt');
});

test('_saveBlock: geleerter Block bleibt dirty und zeigt den Leer-Hinweis', async () => {
  const { ctx } = saveCtx();
  const block = {
    kind: 'page', pageId: 4, html: '<p></p>', originalHtml: '<p>alt</p>',
    dirty: true, saving: false, conflict: null, offline: false, saveError: '',
  };
  await ctx._saveBlock(block);
  assert.equal(block.dirty, true);
  assert.equal(block.saveError, 'bookEditor.emptyAbort');
});

// «Alle speichern» mit gestubbter Queue: der Stub setzt die Endzustände.
function saveAllCtx(blocks, outcome) {
  const byId = new Map(blocks.map((b) => [b.pageId, b]));
  return {
    ...bookEditorSaveMethods,
    blocks,
    saveQueue: [],
    saveAllRunning: false,
    saveAllIds: [],
    _blockById: (id) => byId.get(id) || null,
    _processQueue: async () => { for (const b of blocks) outcome(b); },
  };
}

const page = (pageId) => ({ kind: 'page', pageId, dirty: true, saving: false, conflict: null, saveError: '', offline: false });

test('saveAllDirty: hängende Abschnitte (Konflikt, Fehler, offline) → eine Fehlermeldung mit Anzahl', async () => {
  statuses.length = 0;
  const blocks = [page(1), page(2), page(3), page(4)];
  const ctx = saveAllCtx(blocks, (b) => {
    if (b.pageId === 1) b.dirty = false;
    if (b.pageId === 2) b.conflict = { remoteUserName: 'x' };
    if (b.pageId === 3) b.offline = true;
    if (b.pageId === 4) b.dirty = true;   // während des Laufs weitergetippt → kein Problem
  });
  await ctx.saveAllDirty();
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].isError, true);
  assert.equal(statuses[0].msg, 'bookEditor.saveAllIncomplete:{"n":2,"total":4}');
  assert.equal(ctx.saveAllRunning, false);
  assert.deepEqual(ctx.saveAllIds, []);
});

test('saveAllDirty: alles gespeichert → keine Meldung', async () => {
  statuses.length = 0;
  const ctx = saveAllCtx([page(1), page(2)], (b) => { b.dirty = false; });
  await ctx.saveAllDirty();
  assert.equal(statuses.length, 0);
});
