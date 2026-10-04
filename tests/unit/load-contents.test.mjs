// Scope-Dispatch fuer Buch/Kapitel/Seite. Mocked content-store via require-cache-
// Override, damit kein Content-Store-Zugriff noetig wird.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);

// content-store ist ein Folder mit index.js (Backend-Facade).
// require.resolve trifft den Folder-Pfad — den Cache-Key brauchen wir
// fuer den Mock-Override.
const csKey = require_.resolve('../../lib/content-store');
const lcKey = require_.resolve('../../lib/load-contents.js');

function installFakeContentStore(impl) {
  require_.cache[csKey] = { id: csKey, filename: csKey, loaded: true, exports: impl };
  delete require_.cache[lcKey];
}

const fakePage = (id, chapter_id, name, html = '<p>x</p>') => ({
  id, chapter_id, name, slug: `p-${id}`, position: id, html,
});
const fakeChapter = (id, book_id, name, position = 1) => ({
  id, book_id, name, slug: `c-${id}`, position, description: '',
});
const fakeBook = (id, name = 'Buch') => ({ id, name, slug: 'buch' });

test('scope=book gruppiert nach Kapitel und respektiert Position', async () => {
  installFakeContentStore({
    loadBook:    async () => fakeBook(7),
    // content-store.listChapters liefert bereits position-sortiert.
    listChapters: async () => [fakeChapter(10, 7, 'A', 1), fakeChapter(20, 7, 'B', 2)],
    listPages:   async () => [fakePage(101, 10, 'p1'), fakePage(102, 20, 'p2'), fakePage(103, 10, 'p1b')],
    loadChapter: async () => null,
    loadPage:    async () => null,
    loadPagesBatch: async (metas) => metas.map(m => ({ ...m, html: '<p>body</p>' })),
  });
  const { loadContents } = require_('../../lib/load-contents.js');
  const out = await loadContents({ scope: 'book', id: 7 }, { id: 'x', pw: 'y' });
  assert.equal(out.scope, 'book');
  assert.equal(out.groups.length, 2);
  assert.equal(out.groups[0].chapter.id, 10);
  assert.equal(out.groups[0].pages.length, 2);
  assert.equal(out.groups[1].chapter.id, 20);
});

test('scope=book leer → BOOK_EMPTY', async () => {
  installFakeContentStore({
    loadBook:    async () => fakeBook(8),
    listChapters: async () => [],
    listPages:   async () => [],
    loadChapter: async () => null,
    loadPage:    async () => null,
    loadPagesBatch: async () => [],
  });
  const { loadContents } = require_('../../lib/load-contents.js');
  await assert.rejects(() => loadContents({ scope: 'book', id: 8 }, { id: 'x', pw: 'y' }), /BOOK_EMPTY/);
});

test('scope=chapter filtert Seiten korrekt', async () => {
  installFakeContentStore({
    loadBook:    async () => fakeBook(9),
    listChapters: async () => [fakeChapter(50, 9, 'Eins')],
    listPages:   async () => [fakePage(201, 50, 'a'), fakePage(202, 99, 'b')],
    loadChapter: async (id) => id === 50 ? fakeChapter(50, 9, 'Eins') : null,
    loadPage:    async () => null,
    loadPagesBatch: async (metas) => metas.map(m => ({ ...m, html: '<p>body</p>' })),
  });
  const { loadContents } = require_('../../lib/load-contents.js');
  const out = await loadContents({ scope: 'chapter', id: 50 }, { id: 'x', pw: 'y' });
  assert.equal(out.scope, 'chapter');
  assert.equal(out.chapter.id, 50);
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].pages.length, 1);
  assert.equal(out.groups[0].pages[0].p.id, 201);
});

test('scope=chapter leer → CHAPTER_EMPTY', async () => {
  installFakeContentStore({
    loadBook:    async () => fakeBook(9),
    listChapters: async () => [],
    listPages:   async () => [],
    loadChapter: async () => fakeChapter(50, 9, 'Eins'),
    loadPage:    async () => null,
    loadPagesBatch: async () => [],
  });
  const { loadContents } = require_('../../lib/load-contents.js');
  await assert.rejects(() => loadContents({ scope: 'chapter', id: 50 }, { id: 'x', pw: 'y' }), /CHAPTER_EMPTY/);
});

test('scope=page liefert single-page group', async () => {
  installFakeContentStore({
    loadBook:    async (id) => fakeBook(id),
    listChapters: async () => [],
    listPages:   async () => [],
    loadChapter: async (id) => fakeChapter(id, 11, 'K'),
    loadPage:    async (id) => ({ ...fakePage(id, 70, 'Single'), book_id: 11 }),
    loadPagesBatch: async () => [],
  });
  const { loadContents } = require_('../../lib/load-contents.js');
  const out = await loadContents({ scope: 'page', id: 555 }, { id: 'x', pw: 'y' });
  assert.equal(out.scope, 'page');
  assert.equal(out.page.id, 555);
  assert.equal(out.chapter.id, 70);
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].pages[0].p.id, 555);
});

test('scope=page leer → PAGE_EMPTY', async () => {
  installFakeContentStore({
    loadBook:    async () => fakeBook(11),
    listChapters: async () => [],
    listPages:   async () => [],
    loadChapter: async () => null,
    loadPage:    async () => ({ id: 600, html: '', book_id: 11, chapter_id: null }),
    loadPagesBatch: async () => [],
  });
  const { loadContents } = require_('../../lib/load-contents.js');
  await assert.rejects(() => loadContents({ scope: 'page', id: 600 }, { id: 'x', pw: 'y' }), /PAGE_EMPTY/);
});

test('scope=book filtert ausgeschlossene Kapitel raus', async () => {
  installFakeContentStore({
    loadBook:    async () => fakeBook(7),
    listChapters: async () => [
      { ...fakeChapter(10, 7, 'A', 1), excluded: false },
      { ...fakeChapter(20, 7, 'B', 2), excluded: true },
    ],
    listPages:   async () => [fakePage(101, 10, 'p1'), fakePage(102, 20, 'p2')],
    loadChapter: async () => null,
    loadPage:    async () => null,
    loadPagesBatch: async (metas) => metas.map(m => ({ ...m, html: '<p>body</p>' })),
  });
  const { loadContents } = require_('../../lib/load-contents.js');
  const out = await loadContents({ scope: 'book', id: 7 }, { id: 'x', pw: 'y' });
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].chapter.id, 10);
});

test('scope=book: ausgeschlossenes Elternkapitel kaskadiert auf Unterkapitel', async () => {
  installFakeContentStore({
    loadBook:    async () => fakeBook(7),
    listChapters: async () => [
      { ...fakeChapter(10, 7, 'Parent', 1), excluded: true, parent_chapter_id: null },
      { ...fakeChapter(11, 7, 'Child', 2), excluded: false, parent_chapter_id: 10 },
      { ...fakeChapter(20, 7, 'Other', 3), excluded: false, parent_chapter_id: null },
    ],
    listPages:   async () => [fakePage(101, 10, 'p1'), fakePage(102, 11, 'p2'), fakePage(103, 20, 'p3')],
    loadChapter: async () => null,
    loadPage:    async () => null,
    loadPagesBatch: async (metas) => metas.map(m => ({ ...m, html: '<p>body</p>' })),
  });
  const { loadContents } = require_('../../lib/load-contents.js');
  const out = await loadContents({ scope: 'book', id: 7 }, { id: 'x', pw: 'y' });
  // Parent (excluded) + dessen Child raus → nur 'Other' bleibt.
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].chapter.id, 20);
});

test('bad scope/id → BAD_SCOPE / BAD_ID', async () => {
  installFakeContentStore({
    loadBook: async () => null, listChapters: async () => [], listPages: async () => [],
    loadChapter: async () => null, loadPage: async () => null, loadPagesBatch: async () => [],
  });
  const { loadContents } = require_('../../lib/load-contents.js');
  await assert.rejects(() => loadContents({ scope: 'xyz', id: 1 }, {}), /BAD_SCOPE/);
  await assert.rejects(() => loadContents({ scope: 'book', id: 0 }, {}), /BAD_ID/);
});
