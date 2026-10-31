'use strict';
// Kompletter History-Reset eines Buchs fuer EINEN User (DELETE /history/book/:id):
// page_checks, Buch-/Kapitel-Bewertungen, Chat-Sessions (Nachrichten via ON DELETE
// CASCADE), Werkstatt-Laeufe, Tagebuch-Rueckblicke und die Bewertungs-Caches —
// ohne die Caches lieferte die naechste Bewertung nach dem Reset wortgleich das
// alte Ergebnis. Eine Transaktion; Rueckgabe = geloeschte Zeilen je Bereich.

const { db } = require('./connection');
require('./migrations');
const { deleteReviewCache, deleteChapterMacroReviewCache } = require('./ai-caches');
const { deleteRueckblickCache } = require('./rueckblick');

const TABLES = Object.freeze({
  page_checks: 'page_checks',
  book_reviews: 'book_reviews',
  chapter_reviews: 'chapter_reviews',
  chat_sessions: 'chat_sessions',
  werkstatt_runs: 'werkstatt_runs',
  rueckblicke: 'tagebuch_rueckblicke',
});

const _stmts = Object.fromEntries(Object.entries(TABLES).map(([key, table]) => [
  key, db.prepare(`DELETE FROM ${table} WHERE book_id = ? AND user_email = ?`),
]));

function resetBookHistory(bookId, userEmail) {
  return db.transaction(() => {
    const out = {};
    for (const [key, stmt] of Object.entries(_stmts)) out[key] = stmt.run(bookId, userEmail).changes;
    out.review_cache = deleteReviewCache(bookId, userEmail)
      + deleteChapterMacroReviewCache(bookId, userEmail)
      + deleteRueckblickCache(bookId, userEmail);
    return out;
  })();
}

module.exports = { resetBookHistory };
