'use strict';
// Lese-Abfragen auf `page_checks` (Lektorats-Läufe), die den Seitennamen zur
// Lesezeit per JOIN auf `pages` brauchen — Muster db/sources/citations.js#
// listSourceCitations: der Namens-JOIN gehört nicht in den Route-Handler
// (CLAUDE.md „Content-Store-Facade als einziger Eintrittspunkt").

const { db } = require('./connection');

const _stmtCheckOwned = db.prepare(`
  SELECT pc.page_id, p.page_name, pc.book_id, pc.chapter_id
    FROM page_checks pc
    LEFT JOIN pages p ON p.page_id = pc.page_id
   WHERE pc.id = ? AND pc.user_email = ?
`);

/** Lauf `id` des Users `email` mit Seitenname, oder undefined (fremd/fehlend). */
function getOwnedCheck(id, email) {
  return _stmtCheckOwned.get(id, email);
}

const _stmtChecksForPage = db.prepare(`
  SELECT pc.id, pc.page_id, p.page_name, pc.book_id, pc.chapter_id, pc.checked_at,
         pc.error_count, pc.stilanalyse, pc.fazit, pc.model, pc.saved, pc.saved_at
    FROM page_checks pc
    LEFT JOIN pages p ON p.page_id = pc.page_id
   WHERE pc.page_id = ? AND pc.user_email = ?
   ORDER BY pc.checked_at DESC LIMIT ?
`);

/** Letzte `limit` Läufe einer Seite für einen User (Liste, ohne grosse JSON-Felder). */
function listPageChecks(pageId, email, limit = 20) {
  return _stmtChecksForPage.all(pageId, email, limit);
}

const _stmtCoverageTotal = db.prepare('SELECT COUNT(*) AS total FROM page_stats WHERE book_id = ?');
// Nur Abschnitte, die das Buch noch hat (page_stats) — Prüfungen gelöschter
// oder in ein anderes Buch verschobener Abschnitte zählen sonst weiter mit.
const _stmtCoverageChecked = db.prepare(`
  SELECT COUNT(DISTINCT pc.page_id) AS checked
    FROM page_checks pc
    JOIN page_stats ps ON ps.page_id = pc.page_id AND ps.book_id = pc.book_id
   WHERE pc.book_id = ?
`);

/** Lektorat-Abdeckung eines Buchs, Cross-User: geprüfte / gesamte Abschnitte. */
function lektoratCoverage(bookId) {
  const { total } = _stmtCoverageTotal.get(bookId);
  const { checked } = _stmtCoverageChecked.get(bookId);
  // Abgerundet: 199 von 200 sind 99 %, nicht 100 % — der volle Ring heisst „alles geprüft".
  const pct = total > 0 ? Math.floor((checked / total) * 100) : 0;
  return { checked_pages: checked, total_pages: total, pct };
}

module.exports = { getOwnedCheck, listPageChecks, lektoratCoverage };
