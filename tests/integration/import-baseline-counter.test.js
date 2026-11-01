'use strict';
// Integration test: kumulativer Import-Zaehler in book_stats_history
// (lib/import-baseline.js + routes/sync.js, docs/my-stats.md „Importe").

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let contentStore;
let db;

test.before(() => {
  ctx = bootstrap();
  contentStore = require('../../lib/content-store');
  ({ db } = require('../../db/connection'));
});
test.after(() => { ctx.cleanup(); });

const logger = { info() {}, warn(m) { throw new Error(m); } };
const row = (bookId, day) => db.prepare(
  'SELECT chars, imported_chars, imported_words, imported_pages FROM book_stats_history WHERE book_id = ? AND recorded_at = ?'
).get(bookId, day);

test('seedImportBaseline bucht nur den Import-Zuwachs, Sync erbt und behaelt ihn', async () => {
  const { syncBook } = require('../../routes/sync');
  const { seedImportBaseline } = require('../../lib/import-baseline');
  const { localIsoDate, localIsoDaysAgo } = require('../../lib/local-date');
  const userEmail = 'tester@test.dev';
  const book = await contentStore.createBook({ name: 'Import', owner_email: userEmail }, null);

  // Bestand vor dem Import, gesynct (page_stats gefuellt).
  await contentStore.createPage({ book_id: book.id, chapter_id: null, name: 'Alt', html: '<p>Schon da.</p>' }, null);
  await syncBook(book.id, null);
  const before = row(book.id, localIsoDate());
  assert.equal(before.imported_chars, 0);

  // Import: zwei neue Abschnitte, danach die Baseline.
  await contentStore.createPage({ book_id: book.id, chapter_id: null, name: 'Neu 1', html: '<p>Importierter Text eins.</p>' }, null);
  await contentStore.createPage({ book_id: book.id, chapter_id: null, name: 'Neu 2', html: '<p>Importierter Text zwei.</p>' }, null);
  await seedImportBaseline(book.id, userEmail, logger, 'Test-Import');

  const today = row(book.id, localIsoDate());
  assert.equal(today.imported_chars, today.chars - before.chars, 'genau der Zuwachs des Imports');
  assert.equal(today.imported_pages, 2);
  assert.ok(today.imported_words > 0);
  assert.deepEqual(row(book.id, localIsoDaysAgo(1)), today, 'Vortags-Baseline traegt den Zaehler mit');

  // Re-Sync am selben Tag laesst den Zaehler stehen.
  await syncBook(book.id, null);
  assert.equal(row(book.id, localIsoDate()).imported_chars, today.imported_chars);

  // Neue Tageszeile erbt vom juengsten Vorgaenger: heutige Zeile auf gestern
  // zurueckdatieren (Baseline vorher weg), dann neu syncen.
  db.prepare('DELETE FROM book_stats_history WHERE book_id = ? AND recorded_at = ?').run(book.id, localIsoDaysAgo(1));
  db.prepare('UPDATE book_stats_history SET recorded_at = ? WHERE book_id = ? AND recorded_at = ?')
    .run(localIsoDaysAgo(1), book.id, localIsoDate());
  await syncBook(book.id, null);
  assert.equal(row(book.id, localIsoDate()).imported_chars, today.imported_chars);
});
