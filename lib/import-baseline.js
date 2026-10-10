'use strict';
// Vortags-Baseline nach einem Import. EINE Stelle fuer alle Wege, die ein Buch
// in einem Zug befuellen (Ordner-, Manuskript-, .swbook-, WordPress- und
// HubSpot-Import): ohne Snapshot vor heute zaehlte der ganze Import im
// Heute-Ring (public/js/today-ring.js) und in „Meine Statistik" als heute
// geschrieben.

// Buch-Stats syncen und den heutigen Snapshot als Vortags-Baseline kopieren.
// Non-fatal: `logger` braucht nur info/warn.
async function seedImportBaseline(bookId, userEmail, logger, label) {
  try {
    const { syncBook } = require('../routes/sync');
    const { db } = require('../db/connection');
    const { localIsoDate, localIsoDaysAgo } = require('./local-date');
    await syncBook(bookId, { session: { user: { email: userEmail } } });
    const yesterday = localIsoDaysAgo(1);
    db.prepare(`
      INSERT INTO book_stats_history (book_id, recorded_at, page_count, words, chars, tok, unique_words, chapter_count, avg_sentence_len, avg_lix, avg_flesch_de)
      SELECT book_id, ?, page_count, words, chars, tok, unique_words, chapter_count, avg_sentence_len, avg_lix, avg_flesch_de
        FROM book_stats_history WHERE book_id = ? AND recorded_at = ?
      ON CONFLICT(book_id, recorded_at) DO UPDATE SET
        page_count=excluded.page_count, words=excluded.words, chars=excluded.chars, tok=excluded.tok,
        unique_words=excluded.unique_words, chapter_count=excluded.chapter_count,
        avg_sentence_len=excluded.avg_sentence_len, avg_lix=excluded.avg_lix, avg_flesch_de=excluded.avg_flesch_de
    `).run(yesterday, bookId, localIsoDate());
    logger.info(`Vortags-Baseline gesetzt (${yesterday}) aus ${label}.`);
  } catch (e) {
    logger.warn(`Baseline-Snapshot nach ${label} fehlgeschlagen: ${e.message}`);
  }
}

module.exports = { seedImportBaseline };
