'use strict';
// Lese-Abfragen der Analyse-Tools des Buch-Chats
// (routes/jobs/chat-tools/tools-analysis.js): Reviews, Lektorat-Hotspots
// und -Findings, Stil-Metriken, Seitentexte für die N-Gram-Suche. Handler fassen
// `pages`/`chapters`/`books` nie selbst an (CLAUDE.md „Content-Store-Facade als
// einziger Eintrittspunkt"); optionale Filter werden hier ans SQL gehängt.

const { db } = require('../connection');
require('../migrations');
const { chapterSubtreeFilter } = require('../book-order');

// ── Reviews ──────────────────────────────────────────────────────────────────

const _stmtLatestBookReview = db.prepare(`
    SELECT br.reviewed_at, br.review_json, br.model, b.name AS book_name,
           (SELECT MAX(datetime(p.updated_at)) FROM pages p WHERE p.book_id = br.book_id)
             > datetime(br.reviewed_at) AS stale
    FROM book_reviews br
    LEFT JOIN books b ON b.book_id = br.book_id
    WHERE br.book_id = ? AND br.user_email IS ?
    ORDER BY br.reviewed_at DESC
    LIMIT 1
  `);

/** Jüngste Buchbewertung mit Buchname und stale-Flag (1 = Seite danach editiert). */
function getLatestBookReview(bookId, userEmail) {
  return _stmtLatestBookReview.get(bookId, userEmail);
}

/** Jüngste Kapitelbewertung je Kapitel, optional auf `chapterIds` begrenzt
 *  (leere/fehlende Liste = alle Kapitel). */
function listLatestChapterReviews(bookId, userEmail, chapterIds) {
  let sql = `
    SELECT cr.chapter_id, c.chapter_name, c.position AS chapter_position, cr.reviewed_at, cr.review_json, cr.model,
           (SELECT MAX(datetime(p.updated_at)) FROM pages p
              WHERE p.chapter_id = cr.chapter_id AND p.book_id = cr.book_id)
             > datetime(cr.reviewed_at) AS stale
    FROM chapter_reviews cr
    JOIN chapters c ON c.chapter_id = cr.chapter_id AND c.book_id = cr.book_id
    WHERE cr.book_id = ? AND cr.user_email IS ?
      AND cr.reviewed_at = (
        SELECT MAX(cr2.reviewed_at) FROM chapter_reviews cr2
        WHERE cr2.chapter_id = cr.chapter_id
          AND cr2.book_id = cr.book_id
          AND cr2.user_email IS ?
      )
  `;
  const params = [bookId, userEmail, userEmail];
  if (chapterIds && chapterIds.length) {
    sql += ` AND cr.chapter_id IN (${chapterIds.map(() => '?').join(',')})`;
    params.push(...chapterIds);
  }
  return db.prepare(sql).all(...params);
}

// ── Lektorat (jüngster page_check je Seite) ─────────────────────────────────

const _LATEST_CHECK_WHERE = `
    WHERE pc.book_id = ? AND pc.user_email IS ?
      AND pc.checked_at = (
        SELECT MAX(pc2.checked_at) FROM page_checks pc2
        WHERE pc2.page_id = pc.page_id AND pc2.user_email IS ?
      )
  `;

/** Jüngster Lektorat-Check je Seite (Kopfdaten), optional auf ein Kapitel
 *  begrenzt; Fehlerzahl absteigend. */
function listLektoratHotspotRows(bookId, userEmail, chapterId) {
  let sql = `
    SELECT pc.page_id, pc.checked_at, pc.error_count, pc.fazit, pc.stilanalyse,
           p.page_name, p.chapter_id, c.chapter_name
    FROM page_checks pc
    JOIN pages    p ON p.page_id    = pc.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id` + _LATEST_CHECK_WHERE;
  const params = [bookId, userEmail, userEmail];
  if (chapterId !== null) {
    const f = chapterSubtreeFilter('p.chapter_id', chapterId);
    sql += ` AND ${f.sql}`; params.push(...f.params);
  }
  sql += ' ORDER BY pc.error_count DESC, pc.checked_at DESC';
  return db.prepare(sql).all(...params);
}

/** Jüngster Lektorat-Check je Seite mit errors_json, in Leserichtung. Filter:
 *  `pageId` (hat Vorrang) oder `chapterId`, beide null = ganzes Buch. */
function listLektoratFindingRows(bookId, userEmail, { pageId = null, chapterId = null } = {}) {
  let sql = `
    SELECT pc.page_id, pc.checked_at, pc.errors_json, pc.error_count,
           p.page_name, p.chapter_id, c.chapter_name
    FROM page_checks pc
    JOIN pages    p ON p.page_id    = pc.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id` + _LATEST_CHECK_WHERE;
  const params = [bookId, userEmail, userEmail];
  if (pageId !== null)         { sql += ' AND pc.page_id = ?';   params.push(pageId); }
  else if (chapterId !== null) {
    const f = chapterSubtreeFilter('p.chapter_id', chapterId);
    sql += ` AND ${f.sql}`; params.push(...f.params);
  }
  sql += ' ORDER BY c.position, p.position, p.page_id';
  return db.prepare(sql).all(...params);
}

// ── Stil-Metriken ────────────────────────────────────────────────────────────

/** Spalten von page_stats, nach denen `listPageStilMetric` sortieren darf. */
const STIL_METRIC_COLS = ['filler_count', 'passive_count', 'adverb_count', 'sentences', 'dialog_chars', 'avg_sentence_len', 'sentence_len_p90', 'lix', 'flesch_de'];

const _stmtBookStilTotals = db.prepare(`
      SELECT
        COUNT(*) AS pages,
        SUM(words) AS words, SUM(chars) AS chars,
        SUM(sentences) AS sentences, SUM(dialog_chars) AS dialog_chars,
        SUM(filler_count) AS filler_count,
        SUM(passive_count) AS passive_count,
        SUM(adverb_count) AS adverb_count,
        AVG(avg_sentence_len) AS avg_sentence_len,
        AVG(sentence_len_p90) AS sentence_len_p90,
        AVG(lix) AS lix, AVG(flesch_de) AS flesch_de
      FROM page_stats
      WHERE book_id = ? AND sentences IS NOT NULL
    `);

/** Buchweites Stil-Aggregat über alle Seiten mit Satz-Metriken (pages = 0 ohne Daten). */
function getBookStilTotals(bookId) {
  return _stmtBookStilTotals.get(bookId);
}

/** Stil-Aggregat je Kapitel (eigene Abschnitte) in Leserichtung, optional auf
 *  ein Kapitel samt Unterkapiteln begrenzt (eine Zeile je Kapitel des Teilbaums). */
function listChapterStilMetrics(bookId, chapterId) {
  let sql = `
      SELECT p.chapter_id, c.chapter_name,
             COUNT(*) AS pages,
             SUM(ps.words) AS words, SUM(ps.chars) AS chars,
             SUM(ps.sentences) AS sentences, SUM(ps.dialog_chars) AS dialog_chars,
             SUM(ps.filler_count) AS filler_count,
             SUM(ps.passive_count) AS passive_count,
             SUM(ps.adverb_count) AS adverb_count,
             AVG(ps.avg_sentence_len) AS avg_sentence_len,
             AVG(ps.sentence_len_p90) AS sentence_len_p90,
             AVG(ps.lix) AS lix, AVG(ps.flesch_de) AS flesch_de
      FROM page_stats ps
      JOIN pages p ON p.page_id = ps.page_id
      LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
      WHERE ps.book_id = ? AND ps.sentences IS NOT NULL
    `;
  const params = [bookId];
  if (chapterId !== null) {
    const f = chapterSubtreeFilter('p.chapter_id', chapterId);
    sql += ` AND ${f.sql}`; params.push(...f.params);
  }
  sql += ' GROUP BY p.chapter_id, c.chapter_name, c.position ORDER BY c.position';
  return db.prepare(sql).all(...params);
}

const _stmtTopFiguresInChapter = db.prepare(`
      SELECT f.fig_id, f.name, SUM(pfm.count) AS total
      FROM page_figure_mentions pfm
      JOIN pages p  ON p.page_id = pfm.page_id
      JOIN figures f ON f.id = pfm.figure_id
      WHERE p.chapter_id = ? AND p.book_id = ? AND f.user_email IS ?
      GROUP BY f.id
      ORDER BY total DESC
      LIMIT 5
    `);

/** Die fünf meisterwähnten Figuren in den eigenen Abschnitten eines Kapitels
 *  (Index-Erwähnungen) — passend zur Stil-Zeile je Kapitel. */
function listTopFiguresInChapter(chapterId, bookId, userEmail) {
  return _stmtTopFiguresInChapter.all(chapterId, bookId, userEmail);
}

/** Seiten sortiert nach einer Stil-Metrik. `metric` muss aus STIL_METRIC_COLS
 *  stammen (wird ins SQL interpoliert), `order` ist 'ASC' oder 'DESC'. */
function listPageStilMetric(bookId, metric, order, limit) {
  if (!STIL_METRIC_COLS.includes(metric)) throw new Error(`Unbekannte Stil-Metrik: ${metric}`);
  const dir = order === 'ASC' ? 'ASC' : 'DESC';
  const sql = `
    SELECT ps.page_id, p.page_name, p.chapter_id, c.chapter_name,
           ps.words, ps.${metric} AS metric_value
    FROM page_stats ps
    JOIN pages p ON p.page_id = ps.page_id
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE ps.book_id = ? AND ps.${metric} IS NOT NULL
    ORDER BY ps.${metric} ${dir}, ps.page_id
    LIMIT ?
  `;
  return db.prepare(sql).all(bookId, limit);
}

// ── Seitentexte (N-Gram-Wiederholungen) ─────────────────────────────────────

/** Seiten mit body_html eines Buchs; `pageId` bzw. `chapterId` grenzen ein. */
function listPagesWithBody(bookId, { chapterId = null, pageId = null } = {}) {
  let sql = 'SELECT page_id, page_name, chapter_id, body_html FROM pages WHERE book_id = ? AND body_html IS NOT NULL';
  const params = [bookId];
  if (chapterId !== null) {
    const f = chapterSubtreeFilter('chapter_id', chapterId);
    sql += ` AND ${f.sql}`;
    params.push(...f.params);
  } else if (pageId !== null) {
    sql += ' AND page_id = ?';
    params.push(pageId);
  }
  return db.prepare(sql).all(...params);
}

module.exports = {
  STIL_METRIC_COLS,
  getLatestBookReview,
  getBookStilTotals,
  listLatestChapterReviews,
  listLektoratHotspotRows,
  listLektoratFindingRows,
  listChapterStilMetrics,
  listTopFiguresInChapter,
  listPageStilMetric,
  listPagesWithBody,
};
