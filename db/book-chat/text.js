'use strict';
// Abfragen der textfokussierten Buch-Chat-Tools
// (routes/jobs/book-chat-tools/tools-text.js): Scope-Listen für Passagen- und
// Dialogsuche, Seiten-/Kapitel-Kopfdaten, jüngster Seiten-Check, Orts-Lookup
// und Orts-Erwähnungen je Kapitel. Das Tool führt selbst kein SQL aus. Den
// Seitentext selbst lädt das Tool über die Content-Store-Facade; Handler fassen
// `pages`/`chapters`/`books` nie selbst an (CLAUDE.md „Content-Store-Facade als
// einziger Eintrittspunkt"). Optionale Filter werden hier ans SQL gehängt.

const { db } = require('../connection');
require('../migrations');

/** Seiten mit body_html für search_passages. Filter optional: `chapterId`,
 *  `pageId`, `pageIds` (FTS-Kandidaten); null = kein Filter. Ohne ORDER BY —
 *  der Aufrufer sortiert nach FTS-Rang. */
function listPagesForPassageSearch(bookId, { chapterId = null, pageId = null, pageIds = null } = {}) {
  const scopeFilters = ['book_id = ?'];
  const scopeParams  = [bookId];
  if (chapterId !== null) {
    scopeFilters.push('chapter_id = ?');
    scopeParams.push(chapterId);
  }
  if (pageId !== null) {
    scopeFilters.push('page_id = ?');
    scopeParams.push(pageId);
  }
  if (pageIds) {
    scopeFilters.push(`page_id IN (${pageIds.map(() => '?').join(',')})`);
    scopeParams.push(...pageIds);
  }
  return db.prepare(`
    SELECT page_id, page_name, chapter_id, body_html
    FROM pages
    WHERE ${scopeFilters.join(' AND ')}
  `).all(...scopeParams);
}

const _stmtPageWithChapter = db.prepare(`
    SELECT p.page_id, p.page_name, p.book_id, c.chapter_id, c.chapter_name
    FROM pages p
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE p.page_id = ?
  `);

/** `{ page_id, page_name, book_id, chapter_id, chapter_name }` einer Seite oder
 *  undefined. chapter_* sind NULL, wenn das Kapitel fehlt oder in einem anderen
 *  Buch liegt. */
function getPageWithChapter(pageId) {
  return _stmtPageWithChapter.get(pageId);
}

/** Seiten mit body_html für get_dialogue in Leserichtung, optional auf
 *  `chapterId` und/oder `pageId` begrenzt. */
function listPagesForDialogue(bookId, { chapterId = null, pageId = null } = {}) {
  let sql = `SELECT p.page_id, p.page_name, p.chapter_id, p.body_html
    FROM pages p
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE p.book_id = ? AND p.body_html IS NOT NULL`;
  const params = [bookId];
  if (chapterId !== null) { sql += ' AND p.chapter_id = ?'; params.push(chapterId); }
  if (pageId !== null)    { sql += ' AND p.page_id    = ?'; params.push(pageId); }
  sql += ' ORDER BY c.position, p.position, p.page_id';
  return db.prepare(sql).all(...params);
}

const _stmtLatestPageCheck = db.prepare(`
    SELECT checked_at, error_count, fazit, stilanalyse, model
    FROM page_checks
    WHERE page_id = ? AND user_email IS ?
    ORDER BY checked_at DESC
    LIMIT 1
  `);

/** Jüngster Lektorat-Check einer Seite für einen User (NULL-sicher). */
function getLatestPageCheck(pageId, userEmail) {
  return _stmtLatestPageCheck.get(pageId, userEmail);
}

const _stmtLocationRefByLocId = db.prepare(
    'SELECT id, loc_id, name FROM locations WHERE book_id = ? AND user_email IS ? AND loc_id = ?'
  );

/** Ort (id, loc_id, name) per loc_id, gescoped auf (Buch, User). */
function getLocationRefByLocId(bookId, userEmail, locId) {
  return _stmtLocationRefByLocId.get(bookId, userEmail, locId);
}

const _stmtLocationChapters = db.prepare(`
    SELECT lc.chapter_id, c.chapter_name, lc.haeufigkeit
    FROM location_chapters lc
    LEFT JOIN chapters c ON c.chapter_id = lc.chapter_id
    WHERE lc.location_id = ?
    ORDER BY c.position
  `);

/** Kapitel-Erwähnungen eines Orts mit Kapitelname, in Leserichtung. */
function listLocationChaptersWithNames(locationId) {
  return _stmtLocationChapters.all(locationId);
}

module.exports = {
  listPagesForPassageSearch,
  getPageWithChapter,
  listPagesForDialogue,
  getLatestPageCheck,
  getLocationRefByLocId,
  listLocationChaptersWithNames,
};
