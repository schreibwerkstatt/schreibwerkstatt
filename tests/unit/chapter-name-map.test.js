'use strict';
// Name → chapter_id für die Auflösung von KI-Kapitelnamen: ein Name, den zwei
// Kapitel tragen, löst NICHT auf (sichtbar unzugeordnet statt still falsch), und
// der Komplett-Loader gibt gleichnamigen Geschwistern eindeutige Prompt-Pfade.
const test = require('node:test');
const assert = require('node:assert/strict');
const { chapterNameMap } = require('../../db/write-helpers');

test('chapterNameMap: eindeutige Namen lösen auf, mehrdeutige fehlen', () => {
  const map = chapterNameMap([
    { chapter_id: 1, chapter_name: 'Teil I' },
    { chapter_id: 2, chapter_name: 'Einleitung' },
    { chapter_id: 3, chapter_name: 'Teil II' },
    { chapter_id: 4, chapter_name: 'Einleitung' },
    { chapter_id: 5, chapter_name: 'Einleitung' },
  ]);
  assert.deepEqual(map, { 'Teil I': 1, 'Teil II': 3 });
});

test('chapterNameMap: dieselbe ID zweimal ist keine Mehrdeutigkeit', () => {
  assert.deepEqual(chapterNameMap([
    { chapter_id: 1, chapter_name: 'A' }, { chapter_id: 1, chapter_name: 'A' },
  ]), { A: 1 });
});

test('loadOrderedBookContents: eindeutige Pfade, mehrdeutiger Rohname fällt aus der Map', async () => {
  const contentStore = require('../../lib/content-store');
  const orig = contentStore.bookTree;
  contentStore.bookTree = async () => ({
    chapters: [
      { id: 1, name: 'Teil I', pages: [], subchapters: [
        { id: 2, name: 'Einleitung', pages: [{ id: 20, name: 'a' }], subchapters: [] },
        { id: 3, name: 'Einleitung', pages: [{ id: 30, name: 'b' }], subchapters: [] },
      ] },
      { id: 4, name: 'Teil II', pages: [], subchapters: [
        { id: 5, name: 'Einleitung', pages: [], subchapters: [] },
      ] },
    ],
    topPages: [],
  });
  try {
    delete require.cache[require.resolve('../../routes/jobs/shared/loader')];
    const { loadOrderedBookContents } = require('../../routes/jobs/shared/loader');
    const { chMap, chNameToId } = await loadOrderedBookContents(1);
    assert.equal(chMap[2], 'Teil I › Einleitung');
    assert.equal(chMap[3], 'Teil I › Einleitung (2)');
    assert.equal(chMap[5], 'Teil II › Einleitung');
    assert.equal(chNameToId['Teil I › Einleitung (2)'], 3);
    assert.equal(chNameToId['Teil II › Einleitung'], 5);
    assert.equal('Einleitung' in chNameToId, false, 'mehrdeutiger Rohname wird nicht geraten');
    assert.equal(chNameToId['Teil I'], 1);
  } finally {
    contentStore.bookTree = orig;
  }
});
