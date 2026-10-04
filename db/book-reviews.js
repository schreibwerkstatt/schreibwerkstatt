'use strict';
// Verlauf der Buchbewertung (`book_reviews`): schreiben aus dem Job
// (routes/jobs/review.js), lesen + löschen aus der History-Route
// (routes/history/reviews.js). Der Persistenz-Cache des Calls lebt getrennt in
// `book_review_cache` / `chapter_review_cache` (db/ai-caches.js).

const { db } = require('./connection');
require('./migrations');
const logger = require('../logger');
const { NOW_ISO_SQL } = require('./now');

const HISTORY_LIMIT = 10;

const _stmtInsert = db.prepare(`
  INSERT INTO book_reviews (book_id, reviewed_at, review_json, model, user_email)
  VALUES (?, ${NOW_ISO_SQL}, ?, ?, ?)`);

const _stmtLatest = db.prepare(`
  SELECT review_json, model FROM book_reviews
  WHERE book_id = ? AND user_email IS ?
  ORDER BY reviewed_at DESC, id DESC LIMIT 1`);

/**
 * Neuen Verlaufseintrag schreiben. `skipIfSameAsLatest`: ist der jüngste
 * Eintrag dieses Buchs inhaltsgleich (gleiches JSON, gleiches Modell), wird
 * nichts geschrieben — ein Cache-Treffer bei unverändertem Text soll den auf
 * zehn Einträge gedeckelten Verlauf nicht mit Kopien füllen.
 * @returns {boolean} true, wenn eine Zeile geschrieben wurde.
 */
function insertBookReview({ bookId, review, model, userEmail }, { skipIfSameAsLatest = false } = {}) {
  const json = JSON.stringify(review);
  if (skipIfSameAsLatest) {
    const latest = _stmtLatest.get(bookId, userEmail || null);
    if (latest && latest.review_json === json && latest.model === model) return false;
  }
  _stmtInsert.run(bookId, json, model, userEmail || null);
  return true;
}

const _stmtHistory = db.prepare(`
  SELECT id, book_id, reviewed_at, review_json, model, user_email
  FROM book_reviews
  WHERE book_id = ? AND user_email IS ?
  ORDER BY reviewed_at DESC, id DESC LIMIT ?`);

/**
 * Die jüngsten Bewertungen eines Buchs, newest-first. Pro-Zeile geparst: eine
 * kaputte `review_json` wird zu `null` (Frontend zeigt nur Kopfzeile und
 * Löschknopf), statt die ganze Liste scheitern zu lassen.
 */
function listBookReviewHistory(bookId, userEmail) {
  return _stmtHistory.all(bookId, userEmail || null, HISTORY_LIMIT).map(r => {
    let review_json = null;
    try { review_json = JSON.parse(r.review_json || 'null'); }
    catch (e) { logger.warn(`[book-reviews] kaputte review_json in Zeile id=${r.id}: ${e.message}`); }
    return { ...r, review_json };
  });
}

const _stmtDelete = db.prepare('DELETE FROM book_reviews WHERE id = ? AND user_email = ?');

function deleteBookReview(id, userEmail) {
  return _stmtDelete.run(id, userEmail).changes;
}

module.exports = { insertBookReview, listBookReviewHistory, deleteBookReview, HISTORY_LIMIT };
