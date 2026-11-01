'use strict';
// Tages-Snapshot der Buchentwicklung (docs/buchentwicklung.md):
//  - Satzlänge aus dem Stil-Index (Abkürzungen beenden keinen Satz, Tabellen zählen nicht)
//  - Wortformen nur aus dem Wortschatz-Scan, keine zweite Zählung im Sync
//  - fehlt eine Seite beim Laden, bleibt der alte Tagesstand stehen

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

const USER = 'snapshot@x.test';
let contentStore, syncBook, db, localIsoDate, bookId;

test.before(async () => {
  bootstrap();
  contentStore = require('../../lib/content-store');
  ({ syncBook } = require('../../routes/sync'));
  db = require('../../db/connection').db;
  ({ localIsoDate } = require('../../lib/local-date'));
  const book = await contentStore.createBook({ name: 'Snapshot-Buch' }, { session: { user: { email: USER } } });
  bookId = book.id;
  await contentStore.createPage({
    book_id: bookId, name: 'S1',
    // 3 Sätze à 5, 3 und 4 Wörter = 12/3 = 4,0. Der Punkt-Splitter fände 8.
    html: '<p>Dr. Meier kam um 14.30 Uhr.</p><p>Er sagte nichts.</p><p>Dann ging er weg.</p>'
      + '<table><tr><td>1.2 Mio. Zeilen. Noch mehr.</td></tr></table>',
  }, null);
  await contentStore.createPage({ book_id: bookId, name: 'S2', html: '<p>«Komm», sagte Anna. Anna kam.</p>' }, null);
});

const today = () => db.prepare('SELECT * FROM book_stats_history WHERE book_id = ? AND recorded_at = ?').get(bookId, localIsoDate());

test('Satzlänge = Σ Wörter in Sätzen / Σ Sätze des Stil-Index', async () => {
  const res = await syncBook(bookId, null);
  assert.equal(res.snapshot, true);
  // S1: 12 Wörter / 3 Sätze, S2: 5 Wörter / 2 Sätze → 17 / 5 = 3,4
  assert.equal(today().avg_sentence_len, 3.4);
  const s1 = db.prepare("SELECT sentences FROM page_stats ps JOIN pages p USING(page_id) WHERE p.page_name = 'S1' AND ps.book_id = ?").get(bookId);
  assert.equal(s1.sentences, 3, 'page_stats.sentences aus derselben Zerlegung');
});

test('Wortformen kommen aus dem Wortschatz-Scan, nicht aus dem Sync', async () => {
  db.prepare('DELETE FROM book_lexicon WHERE book_id = ?').run(bookId);
  await syncBook(bookId, null);
  assert.equal(today().unique_words, null, 'ohne Scan keine Zahl');
  db.prepare("INSERT INTO book_lexicon (book_id, lexicon_version, types) VALUES (?, 1, 42)").run(bookId);
  await syncBook(bookId, null);
  assert.equal(today().unique_words, 42);
});

test('Teil-Ladung: Tages-Snapshot bleibt unverändert', async () => {
  await syncBook(bookId, null);
  const before = today();
  const orig = contentStore.loadPagesBatch;
  contentStore.loadPagesBatch = async (slice, ctx, opts) => (await orig(slice, ctx, opts)).slice(1);
  let res;
  try { res = await syncBook(bookId, null); }
  finally { contentStore.loadPagesBatch = orig; }
  assert.equal(res.snapshot, false);
  assert.equal(res.missing_pages, 1);
  assert.deepEqual(today(), before);
});
