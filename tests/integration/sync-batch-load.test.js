'use strict';
// syncBook laedt Seiten-Bodies batchweise (contentStore.loadPagesBatch), nicht
// je Seite per loadPage (N+1). Gate: ueber mehrere Batches hinweg bekommt jede
// Seite page_stats + preview_text, und loadPage wird dabei nie gerufen.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

const USER = 'batch@x.test';
let contentStore, syncBook, db, bookId;
const pageIds = [];

test.before(async () => {
  bootstrap();
  contentStore = require('../../lib/content-store');
  ({ syncBook } = require('../../routes/sync'));
  db = require('../../db/connection').db;
  const book = await contentStore.createBook({ name: 'Batch-Buch' }, { session: { user: { email: USER } } });
  bookId = book.id;
  const chapter = await contentStore.createChapter({ book_id: bookId, name: 'K1' }, null);
  for (let i = 0; i < 45; i++) {
    const p = await contentStore.createPage(
      { book_id: bookId, chapter_id: chapter.id, name: `S${i}`, html: `<p>Satz ${i} hier.</p><p>Zweiter Absatz.</p>` }, null);
    pageIds.push(p.id);
  }
});

test('syncBook: Stats + Vorschau fuer alle Seiten, ohne Einzel-loadPage', async () => {
  db.prepare('UPDATE pages SET preview_text = NULL WHERE book_id = ?').run(bookId);
  const orig = contentStore.loadPage;
  let singleLoads = 0;
  contentStore.loadPage = async (...a) => { singleLoads++; return orig(...a); };
  try {
    const res = await syncBook(bookId, null);
    assert.equal(res.page_count, 45);
  } finally {
    contentStore.loadPage = orig;
  }
  assert.equal(singleLoads, 0, 'kein N+1 ueber loadPage');

  const stats = db.prepare('SELECT page_id, words, chars FROM page_stats WHERE book_id = ?').all(bookId);
  assert.equal(stats.length, 45);
  const s0 = stats.find(r => r.page_id === pageIds[0]);
  // Gleiche Normalisierung wie routes/sync.js#htmlToText: Tags → ein Leerzeichen, \s+ kollabiert, getrimmt.
  assert.equal(s0.chars, 'Satz 0 hier. Zweiter Absatz.'.length);
  assert.equal(s0.words, 5);

  const previews = db.prepare('SELECT preview_text FROM pages WHERE book_id = ?').all(bookId);
  assert.ok(previews.every(r => r.preview_text && r.preview_text.startsWith('Satz ')));
});
