// Block-Modell des Bucheditors: aus der server-seitig vorsortierten Page-Liste
// wird eine Sequenz `[chapter-header, page, page, …, chapter-header, page, …]`.
// Solo-Pages (chapterId = null) erzeugen KEIN Chapter-Header, fließen direkt
// als Page-Blöcke ein. Pro Page wird ein Block mit dirty/saving/_rev-Felder
// initialisiert.

import test from 'node:test';
import assert from 'node:assert/strict';

// DOM-Stubs vor Modul-Import — utils.js → stripFocusArtefacts nutzt
// document.createElement. Pass-through für unsere reinen HTML-Strings reicht.
globalThis.window = globalThis.window || {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {},
};
globalThis.document = globalThis.document || {
  createElement: () => {
    const el = {
      _html: '',
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = v; },
      querySelectorAll: () => [],
      querySelector: () => null,
      appendChild: () => {},
      replaceChildren: () => {},
    };
    return el;
  },
};

const { buildBlocksFromPages, applySaveOutcome } = await import('../../public/js/cards/book-editor-card.js');

test('buildBlocksFromPages: leeres Input → leeres Array', () => {
  assert.deepEqual(buildBlocksFromPages([]), []);
  assert.deepEqual(buildBlocksFromPages(null), []);
});

test('buildBlocksFromPages: Pages mit Kapiteln → Chapter-Header pro Kapitelwechsel', () => {
  const pages = [
    { pageId: 1, pageName: 'A', chapterId: 10, chapterName: 'K1', html: '<p>a</p>', updated_at: 't1' },
    { pageId: 2, pageName: 'B', chapterId: 10, chapterName: 'K1', html: '<p>b</p>', updated_at: 't2' },
    { pageId: 3, pageName: 'C', chapterId: 20, chapterName: 'K2', html: '<p>c</p>', updated_at: 't3' },
  ];
  const blocks = buildBlocksFromPages(pages);
  assert.equal(blocks.length, 5);
  assert.equal(blocks[0].kind, 'chapter');
  assert.equal(blocks[0].chapterId, 10);
  assert.equal(blocks[0].name, 'K1');
  assert.equal(blocks[1].kind, 'page');
  assert.equal(blocks[1].pageId, 1);
  assert.equal(blocks[2].kind, 'page');
  assert.equal(blocks[2].pageId, 2);
  assert.equal(blocks[3].kind, 'chapter');
  assert.equal(blocks[3].chapterId, 20);
  assert.equal(blocks[4].pageId, 3);
});

test('buildBlocksFromPages: Solo-Pages (chapterId=null) → kein Chapter-Header davor', () => {
  const pages = [
    { pageId: 1, pageName: 'Solo', chapterId: null, html: '<p>x</p>', updated_at: 't1' },
    { pageId: 2, pageName: 'A', chapterId: 10, chapterName: 'K1', html: '<p>a</p>', updated_at: 't2' },
  ];
  const blocks = buildBlocksFromPages(pages);
  assert.equal(blocks[0].kind, 'page');
  assert.equal(blocks[0].pageId, 1);
  assert.equal(blocks[1].kind, 'chapter');
  assert.equal(blocks[2].kind, 'page');
  assert.equal(blocks[2].pageId, 2);
});

test('buildBlocksFromPages: Page-Block hat Initial-Flags + originalHtml-Snapshot', () => {
  const pages = [{ pageId: 7, pageName: 'P', chapterId: null, html: '<p>hi</p>', updated_at: 'X' }];
  const [block] = buildBlocksFromPages(pages);
  assert.equal(block.kind, 'page');
  assert.equal(block.dirty, false);
  assert.equal(block.saving, false);
  assert.equal(block.conflict, null);
  assert.equal(block.saveError, '');
  assert.equal(block.savedAt, null);
  assert.equal(block._rev, 0);
  assert.equal(block.originalUpdatedAt, 'X');
  assert.equal(block.originalHtml, block.html);
});

test('buildBlocksFromPages: aufeinanderfolgende Pages im selben Kapitel → NUR ein Header', () => {
  const pages = [
    { pageId: 1, pageName: 'A', chapterId: 10, chapterName: 'K1', html: '', updated_at: '' },
    { pageId: 2, pageName: 'B', chapterId: 10, chapterName: 'K1', html: '', updated_at: '' },
    { pageId: 3, pageName: 'C', chapterId: 10, chapterName: 'K1', html: '', updated_at: '' },
  ];
  const blocks = buildBlocksFromPages(pages);
  const headers = blocks.filter(b => b.kind === 'chapter');
  assert.equal(headers.length, 1);
  assert.equal(headers[0].chapterId, 10);
});

// ── applySaveOutcome ─────────────────────────────────────────────────────────
// Übernahme des Save-Ergebnisses auf den Block. Kritisch ist der Dirty-Ausgang:
// wer während des laufenden PUT weitertippt, darf sein Dirty-Flag nicht
// verlieren — sonst lehnt _enqueueSave den nachlaufenden Autosave ab
// (`!block.dirty`) und die getippten Zeichen werden nie geschrieben.

const savedBlock = (html) => ({
  kind: 'page', pageId: 1, name: 'P',
  html, originalHtml: '<p>alt</p>', originalUpdatedAt: 'T0',
  dirty: true, saving: true, saveError: 'vorher', conflict: { remoteUserName: 'x' }, savedAt: null,
});

test('applySaveOutcome: unveränderter Block → dirty aus, Snapshot übernommen', () => {
  const block = savedBlock('<p>neu</p>');
  const stillDirty = applySaveOutcome(block, {
    snapshot: '<p>neu</p>', savedHtml: '<p>neu</p>', savedUpdatedAt: 'T1',
  });
  assert.equal(stillDirty, false);
  assert.equal(block.dirty, false);
  assert.equal(block.originalHtml, '<p>neu</p>');
  assert.equal(block.originalUpdatedAt, 'T1');
  assert.equal(block.conflict, null);
  assert.equal(block.saveError, '');
  assert.ok(block.savedAt > 0);
});

test('applySaveOutcome: während des Saves weitergetippt → bleibt dirty', () => {
  const block = savedBlock('<p>neu</p>');
  block.html = '<p>neu und noch mehr</p>';   // Eingabe während des PUT
  const stillDirty = applySaveOutcome(block, {
    snapshot: '<p>neu</p>', savedHtml: '<p>neu</p>', savedUpdatedAt: 'T1',
  });
  assert.equal(stillDirty, true);
  assert.equal(block.dirty, true, 'sonst geht die Eingabe während des Saves verloren');
  assert.equal(block.originalHtml, '<p>neu</p>', 'Vergleichsbasis ist der geschriebene Stand');
});

test('applySaveOutcome: ohne updated_at bleibt der bisherige Stempel stehen', () => {
  const block = savedBlock('<p>neu</p>');
  applySaveOutcome(block, { snapshot: '<p>neu</p>', savedHtml: '<p>neu</p>' });
  assert.equal(block.originalUpdatedAt, 'T0');
});

// ── Konflikt „Remote übernehmen" ─────────────────────────────────────────────
const { bookEditorSaveMethods } = await import('../../public/js/cards/book-editor/save.js');
const { contentRepo } = await import('../../public/js/repo/content.js');

// Minimaler Card-Scope: nur, was resolveConflictTakeRemote anfasst.
const takeRemoteCtx = (activePageId) => ({
  ...bookEditorSaveMethods,
  activePageId,
  _autosave: { clear: () => {} },
});

const conflictBlock = (remoteHtml) => ({
  kind: 'page', pageId: 7, name: 'P', html: '<p>lokal</p>', originalHtml: '<p>alt</p>',
  originalUpdatedAt: 'T0', dirty: true, saving: false, saveError: 'Konflikt', savedAt: null, _rev: 0,
  conflict: { remoteUserName: 'x', remoteUpdatedAt: 'T9', remoteHtml },
});

test('resolveConflictTakeRemote: Remote-HTML aus dem Pre-Check wird übernommen', async () => {
  const ctx = takeRemoteCtx(null);
  const block = conflictBlock('<p>remote</p>');
  await ctx.resolveConflictTakeRemote(block);
  assert.equal(block.html, '<p>remote</p>');
  assert.equal(block.originalHtml, '<p>remote</p>');
  assert.equal(block.originalUpdatedAt, 'T9');
  assert.equal(block.dirty, false);
  assert.equal(block.conflict, null);
  assert.equal(block._rev, 1, 'externe Mutation → Re-Hydrate');
});

test('resolveConflictTakeRemote: 409-Pfad ohne Remote-HTML liest die Seite frisch', async () => {
  const orig = contentRepo.loadPage;
  const calls = [];
  contentRepo.loadPage = async (id, opts) => { calls.push([id, opts]); return { html: '<p>frisch</p>', updated_at: 'T10' }; };
  try {
    const ctx = takeRemoteCtx(null);
    const block = conflictBlock(null);
    await ctx.resolveConflictTakeRemote(block);
    assert.deepEqual(calls, [[7, { fresh: true }]]);
    assert.equal(block.html, '<p>frisch</p>', 'sonst steht eine leere Seite im Stream');
    assert.equal(block.originalUpdatedAt, 'T10');
  } finally {
    contentRepo.loadPage = orig;
  }
});

test('resolveConflictTakeRemote: aktiver Block wird deaktiviert, damit der DOM neu geschrieben wird', async () => {
  const ctx = takeRemoteCtx(7);
  const block = conflictBlock('<p>remote</p>');
  await ctx.resolveConflictTakeRemote(block);
  assert.equal(ctx.activePageId, null,
    'sonst lässt _maybeRehydrate den DOM stehen und der nächste Tastendruck speichert die lokale Fassung');
});

test('buildBlocksFromPages: erster Abschnitt gleichnamig mit Kapitel → dupTitle', () => {
  const blocks = buildBlocksFromPages([
    { pageId: 1, pageName: 'Kapitel 1', chapterId: 10, chapterName: 'Kapitel 1', html: '<p>a</p>' },
    { pageId: 2, pageName: 'Kapitel 1', chapterId: 10, chapterName: 'Kapitel 1', html: '<p>b</p>' },
    { pageId: 3, pageName: 'Szene', chapterId: 20, chapterName: 'Kapitel 2', html: '<p>c</p>' },
  ]);
  const pages = blocks.filter(b => b.kind === 'page');
  assert.deepEqual(pages.map(b => b.dupTitle), [true, false, false]);
});

test('buildOutlineNodes: Ein-Abschnitt-Kapitel ist single, Mehr-Abschnitt-Kapitel nicht', async () => {
  const { buildOutlineNodes } = await import('../../public/js/cards/book-editor/outline.js');
  const nodes = buildOutlineNodes(buildBlocksFromPages([
    { pageId: 1, pageName: 'A', chapterId: 10, chapterName: 'K1', html: '' },
    { pageId: 2, pageName: 'B', chapterId: 20, chapterName: 'K2', html: '' },
    { pageId: 3, pageName: 'C', chapterId: 20, chapterName: 'K2', html: '' },
  ]));
  assert.deepEqual(nodes.map(n => [n.chapterId, n.single]), [[10, true], [20, false]]);
});
