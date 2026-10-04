'use strict';
// Verlauf der Kapitelbewertung (`chapter_reviews`): schreiben aus dem Job
// (routes/jobs/kapitel.js), lesen + löschen aus der History-Route
// (routes/history/reviews.js). Der Persistenz-Cache des Calls lebt getrennt in
// `chapter_macro_review_cache` (db/ai-caches.js).

const { db } = require('./connection');
require('./migrations');
const logger = require('../logger');
const { NOW_ISO_SQL } = require('./now');

const HISTORY_PER_CHAPTER = 10;

const _stmtInsert = db.prepare(`
  INSERT INTO chapter_reviews (book_id, chapter_id, reviewed_at, review_json, model, user_email)
  VALUES (?, ?, ${NOW_ISO_SQL}, ?, ?, ?)`);

const _stmtLatest = db.prepare(`
  SELECT review_json, model FROM chapter_reviews
  WHERE book_id = ? AND chapter_id = ? AND user_email IS ?
  ORDER BY reviewed_at DESC, id DESC LIMIT 1`);

/**
 * Neuen Verlaufseintrag schreiben. `skipIfSameAsLatest`: ist der jüngste
 * Eintrag dieses Kapitels inhaltsgleich (gleiches JSON, gleiches Modell), wird
 * nichts geschrieben — ein Cache-Treffer bei unverändertem Kapitel soll den auf
 * zehn Einträge gedeckelten Verlauf nicht mit Kopien füllen.
 * @returns {boolean} true, wenn eine Zeile geschrieben wurde.
 */
function insertChapterReview({ bookId, chapterId, review, model, userEmail }, { skipIfSameAsLatest = false } = {}) {
  const json = JSON.stringify(review);
  if (skipIfSameAsLatest) {
    const latest = _stmtLatest.get(bookId, chapterId, userEmail || null);
    if (latest && latest.review_json === json && latest.model === model) return false;
  }
  _stmtInsert.run(bookId, chapterId, json, model, userEmail || null);
  return true;
}

// Fensterfunktion statt Volllast + JS-Slice: liest je Kapitel nur die jüngsten
// HISTORY_PER_CHAPTER Zeilen (Index idx_cr_book_chapter_user_date).
const _stmtHistory = db.prepare(`
  WITH ranked AS (
    SELECT id, book_id, chapter_id, reviewed_at, review_json, model, user_email,
           ROW_NUMBER() OVER (PARTITION BY chapter_id ORDER BY reviewed_at DESC, id DESC) AS rn
    FROM chapter_reviews
    WHERE book_id = ? AND user_email IS ?
  )
  SELECT id, book_id, chapter_id, reviewed_at, review_json, model, user_email
  FROM ranked WHERE rn <= ? ORDER BY chapter_id, reviewed_at DESC, id DESC`);

/**
 * Verlauf eines Buchs, gruppiert als `{ [chapter_id]: entry[] }`, newest-first.
 * Pro-Zeile geparst: eine kaputte `review_json` wird zu `null` (Frontend blendet
 * sie aus), statt die ganze Liste scheitern zu lassen.
 */
function listChapterReviewHistory(bookId, userEmail) {
  const byChapter = {};
  for (const r of _stmtHistory.all(bookId, userEmail || null, HISTORY_PER_CHAPTER)) {
    let review_json = null;
    try { review_json = JSON.parse(r.review_json || 'null'); }
    catch (e) { logger.warn(`[chapter-reviews] kaputte review_json in Zeile id=${r.id}: ${e.message}`); }
    const key = String(r.chapter_id);
    (byChapter[key] ||= []).push({ ...r, review_json });
  }
  return byChapter;
}

const _stmtDelete = db.prepare('DELETE FROM chapter_reviews WHERE id = ? AND user_email = ?');

function deleteChapterReview(id, userEmail) {
  return _stmtDelete.run(id, userEmail).changes;
}

module.exports = { insertChapterReview, listChapterReviewHistory, deleteChapterReview, HISTORY_PER_CHAPTER };
