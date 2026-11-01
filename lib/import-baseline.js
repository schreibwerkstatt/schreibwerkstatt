'use strict';
// Vortags-Baseline nach einem Import. EINE Stelle fuer alle Wege, die ein Buch
// in einem Zug befuellen (Ordner-, Manuskript-, .swbook-, WordPress- und
// HubSpot-Import): ohne Snapshot vor heute zaehlte der ganze Import im
// Heute-Ring (public/js/today-ring.js) und in „Meine Statistik" als heute
// geschrieben.

// Buch-Stats syncen und den heutigen Snapshot als Vortags-Baseline kopieren.
// Den Zuwachs des Imports (Stand nach dem Sync minus page_stats davor — der
// Import selbst schreibt keine page_stats) auf den kumulativen `imported_*`-
// Zaehler der Tageszeile buchen; „Meine Statistik" zieht ihn von Umfang und
// Tempo ab (docs/my-stats.md „Importe"). Non-fatal: `logger` braucht nur info/warn.
async function seedImportBaseline(bookId, userEmail, logger, label) {
  try {
    const { syncBook } = require('../routes/sync');
    const { db } = require('../db/connection');
    const { localIsoDate, localIsoDaysAgo } = require('./local-date');
    const sumStats = () => db.prepare(`
      SELECT COALESCE(SUM(chars), 0) AS chars, COALESCE(SUM(words), 0) AS words, COUNT(*) AS pages
      FROM page_stats WHERE book_id = ?
    `).get(bookId);
    const before = sumStats();
    await syncBook(bookId, { session: { user: { email: userEmail } } });
    const after = sumStats();
    const today = localIsoDate();
    const yesterday = localIsoDaysAgo(1);
    db.prepare(`
      UPDATE book_stats_history
         SET imported_chars = imported_chars + ?, imported_words = imported_words + ?, imported_pages = imported_pages + ?
       WHERE book_id = ? AND recorded_at = ?
    `).run(Math.max(0, after.chars - before.chars), Math.max(0, after.words - before.words),
           Math.max(0, after.pages - before.pages), bookId, today);
    db.prepare(`
      INSERT INTO book_stats_history (book_id, recorded_at, page_count, words, chars, tok, unique_words, chapter_count, avg_sentence_len, avg_lix, avg_flesch_de,
                                      imported_chars, imported_words, imported_pages)
      SELECT book_id, ?, page_count, words, chars, tok, unique_words, chapter_count, avg_sentence_len, avg_lix, avg_flesch_de,
             imported_chars, imported_words, imported_pages
        FROM book_stats_history WHERE book_id = ? AND recorded_at = ?
      ON CONFLICT(book_id, recorded_at) DO UPDATE SET
        page_count=excluded.page_count, words=excluded.words, chars=excluded.chars, tok=excluded.tok,
        unique_words=excluded.unique_words, chapter_count=excluded.chapter_count,
        avg_sentence_len=excluded.avg_sentence_len, avg_lix=excluded.avg_lix, avg_flesch_de=excluded.avg_flesch_de,
        imported_chars=excluded.imported_chars, imported_words=excluded.imported_words, imported_pages=excluded.imported_pages
    `).run(yesterday, bookId, today);
    logger.info(`Vortags-Baseline gesetzt (${yesterday}) aus ${label}.`);
  } catch (e) {
    logger.warn(`Baseline-Snapshot nach ${label} fehlgeschlagen: ${e.message}`);
  }
}

module.exports = { seedImportBaseline };
