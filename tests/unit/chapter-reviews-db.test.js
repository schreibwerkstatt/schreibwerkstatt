'use strict';
// Verlauf der Kapitelbewertung (db/chapter-reviews.js): Doppel-Schutz bei
// Cache-Treffern, Deckel pro Kapitel, kaputte Zeile, User-Trennung.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('chapter-reviews-db');

require('../../db/migrations').runMigrations();
const { db } = require('../../db/connection');
const cr = require('../../db/chapter-reviews');

const USER = 'cr@example.com';
const OTHER = 'cr-other@example.com';
const NOW = '2026-10-04T10:00:00.000Z';
let seq = 0;

function newBookWithChapters(n) {
  const bookId = 7100 + (++seq);
  for (const u of [USER, OTHER]) {
    db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(u, u);
  }
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, 'Buch ' + bookId, NOW, NOW, USER);
  const chapters = [];
  for (let i = 0; i < n; i++) {
    const id = 72000 + (++seq);
    db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, bookId, 'K' + i, i, NOW);
    chapters.push(id);
  }
  return { bookId, chapters };
}

test('skipIfSameAsLatest schreibt keine inhaltsgleiche Kopie', () => {
  const { bookId, chapters: [ch] } = newBookWithChapters(1);
  const base = { bookId, chapterId: ch, review: { gesamtnote: 4 }, model: 'm1', userEmail: USER };
  assert.equal(cr.insertChapterReview(base), true);
  assert.equal(cr.insertChapterReview(base, { skipIfSameAsLatest: true }), false);
  // Anderes Modell oder anderer Inhalt → neuer Eintrag.
  assert.equal(cr.insertChapterReview({ ...base, model: 'm2' }, { skipIfSameAsLatest: true }), true);
  assert.equal(cr.insertChapterReview({ ...base, review: { gesamtnote: 5 } }, { skipIfSameAsLatest: true }), true);
  assert.equal(cr.listChapterReviewHistory(bookId, USER)[String(ch)].length, 3);
});

test('Verlauf: höchstens HISTORY_PER_CHAPTER je Kapitel, newest-first, nur eigener User', () => {
  const { bookId, chapters: [a, b] } = newBookWithChapters(2);
  for (let i = 0; i < cr.HISTORY_PER_CHAPTER + 3; i++) {
    cr.insertChapterReview({ bookId, chapterId: a, review: { gesamtnote: i }, model: 'm', userEmail: USER });
  }
  cr.insertChapterReview({ bookId, chapterId: b, review: { gesamtnote: 1 }, model: 'm', userEmail: USER });
  cr.insertChapterReview({ bookId, chapterId: b, review: { gesamtnote: 2 }, model: 'm', userEmail: OTHER });

  const hist = cr.listChapterReviewHistory(bookId, USER);
  assert.equal(hist[String(a)].length, cr.HISTORY_PER_CHAPTER);
  // Gleiche Sekunde → Tiebreak über id: der zuletzt geschriebene steht vorn.
  assert.equal(hist[String(a)][0].review_json.gesamtnote, cr.HISTORY_PER_CHAPTER + 2);
  assert.equal(hist[String(b)].length, 1);
  assert.match(hist[String(a)][0].reviewed_at, /Z$/);
});

test('kaputte review_json wird zu null statt die Liste zu sprengen', () => {
  const { bookId, chapters: [ch] } = newBookWithChapters(1);
  cr.insertChapterReview({ bookId, chapterId: ch, review: { gesamtnote: 3 }, model: 'm', userEmail: USER });
  db.prepare(`INSERT INTO chapter_reviews (book_id, chapter_id, reviewed_at, review_json, model, user_email)
              VALUES (?, ?, ?, ?, ?, ?)`).run(bookId, ch, '2099-01-01T00:00:00.000Z', '{kaputt', 'm', USER);
  const list = cr.listChapterReviewHistory(bookId, USER)[String(ch)];
  assert.equal(list.length, 2);
  assert.equal(list[0].review_json, null);
  assert.equal(list[1].review_json.gesamtnote, 3);
});

test('deleteChapterReview löscht nur eigene Einträge', () => {
  const { bookId, chapters: [ch] } = newBookWithChapters(1);
  cr.insertChapterReview({ bookId, chapterId: ch, review: { gesamtnote: 3 }, model: 'm', userEmail: USER });
  const [entry] = cr.listChapterReviewHistory(bookId, USER)[String(ch)];
  assert.equal(cr.deleteChapterReview(entry.id, OTHER), 0);
  assert.equal(cr.deleteChapterReview(entry.id, USER), 1);
  assert.equal(cr.listChapterReviewHistory(bookId, USER)[String(ch)], undefined);
});
