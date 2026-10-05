'use strict';
// Abfragen der Listing-/Lookup-Tools des Buch-Chats
// (routes/jobs/book-chat-tools/tools-catalog.js): Kapitel- und Seiteninventar,
// Ideen, Orte, Songs, Szenen samt ihren Figuren-/Orts-/Szenen-Bridges,
// Figuren-Erwähnungen, Revisions-Kopf, Welt-Fakten. Das Tool führt selbst kein
// SQL aus; Seiten-/Kapitelnamen kommen per JOIN von hier (CLAUDE.md
// „Content-Store-Facade als einziger Eintrittspunkt"). Optionale Filter und
// IN-Listen werden hier ans SQL gehängt (leere Liste → `(NULL)`, matcht nichts).

const { db } = require('../connection');
require('../migrations');
const { inClause } = require('../../lib/validate');
const { openStatusSql } = require('../../lib/ideen-status');

// ── Kapitel + Seiten ────────────────────────────────────────────────────────

const _stmtChaptersWithStats = db.prepare(`
    SELECT c.chapter_id, c.chapter_name,
           COUNT(p.page_id)            AS page_count,
           COALESCE(SUM(ps.words), 0)  AS words,
           COALESCE(SUM(ps.chars), 0)  AS chars
    FROM chapters c
    LEFT JOIN pages p      ON p.chapter_id = c.chapter_id AND p.book_id = c.book_id
    LEFT JOIN page_stats ps ON ps.page_id = p.page_id
    WHERE c.book_id = ?
    GROUP BY c.chapter_id, c.chapter_name
    ORDER BY c.position
  `);

/** Kapitel eines Buchs mit Seitenzahl und Wort-/Zeichensumme, in Leserichtung. */
function listChaptersWithStats(bookId) {
  return _stmtChaptersWithStats.all(bookId);
}

const _stmtPagesWithStats = db.prepare(`
    SELECT p.page_id, p.page_name, p.chapter_id,
           COALESCE(ps.words, 0) AS words, COALESCE(ps.chars, 0) AS chars
    FROM pages p
    LEFT JOIN page_stats ps ON ps.page_id = p.page_id
    WHERE p.book_id = ?
    ORDER BY p.position, p.page_id
  `);

/** Alle Seiten eines Buchs (auch ohne Kapitel) mit Wort-/Zeichenzahl. */
function listPagesWithStats(bookId) {
  return _stmtPagesWithStats.all(bookId);
}

const _stmtPageHeader = db.prepare(`
    SELECT p.page_id, p.page_name, p.chapter_id, c.chapter_name, p.book_id
    FROM pages p
    LEFT JOIN chapters c ON c.chapter_id = p.chapter_id AND c.book_id = p.book_id
    WHERE p.page_id = ?
  `);

/** Seiten-Kopf für list_revisions: chapter_id aus der Seite selbst (auch wenn
 *  das Kapitel fehlt), chapter_name nur aus demselben Buch. */
function getPageHeader(pageId) {
  return _stmtPageHeader.get(pageId);
}

// ── Ideen ────────────────────────────────────────────────────────────────────

/** Ideen eines Buchs mit Seiten-/Kapitelnamen; offene zuerst, dann jüngste.
 *  Ideen hängen an einer Seite, einem Kapitel oder (ohne Anker) nur am Buch;
 *  `effective_chapter_id` deckt Seite und Kapitel ab. Filter optional: `status`, `offenOnly` (offen +
 *  in_arbeit), `pageId`, `chapterId` (gegen effective_chapter_id). */
function listIdeenWithPlaces(bookId, userEmail, { status = null, offenOnly = false, pageId = null, chapterId = null } = {}) {
  let sql = `
    SELECT i.id, i.content, i.status, i.status_at, i.created_at, i.updated_at,
           i.page_id, p.page_name,
           COALESCE(i.chapter_id, p.chapter_id) AS effective_chapter_id,
           COALESCE(cc.chapter_name, cp.chapter_name) AS chapter_name,
           CASE WHEN i.page_id    IS NOT NULL THEN 'page'
                WHEN i.chapter_id IS NOT NULL THEN 'chapter'
                ELSE 'book' END AS scope
    FROM ideen i
    LEFT JOIN pages    p  ON p.page_id    = i.page_id
    LEFT JOIN chapters cc ON cc.chapter_id = i.chapter_id AND cc.book_id = i.book_id
    LEFT JOIN chapters cp ON cp.chapter_id = p.chapter_id AND cp.book_id = i.book_id
    WHERE i.book_id = ? AND i.user_email = ?
  `;
  const params = [bookId, userEmail];
  if (status)    { sql += ' AND i.status = ?'; params.push(status); }
  if (offenOnly) { sql += ` AND ${openStatusSql('i')}`; }
  if (pageId    !== null) { sql += ' AND i.page_id = ?'; params.push(pageId); }
  if (chapterId !== null) {
    sql += ' AND COALESCE(i.chapter_id, p.chapter_id) = ?';
    params.push(chapterId);
  }
  sql += ` ORDER BY CASE WHEN ${openStatusSql('i')} THEN 0 ELSE 1 END, i.updated_at DESC, i.id DESC`;
  return db.prepare(sql).all(...params);
}

// ── Orte ─────────────────────────────────────────────────────────────────────

/** Orte eines Buchs mit Name der Erst-Erwähnungs-Seite, optional nur Orte, die
 *  im Kapitel `chapterId` vorkommen. */
function listLocationsWithFirstPage(bookId, userEmail, chapterId) {
  let sql = `
    SELECT l.id, l.loc_id, l.name, l.typ, l.beschreibung, l.stimmung,
           l.erste_erwaehnung, l.erste_erwaehnung_page_id, p.page_name AS erste_erwaehnung_page_name
    FROM locations l
    LEFT JOIN pages p ON p.page_id = l.erste_erwaehnung_page_id
    WHERE l.book_id = ? AND l.user_email IS ?
  `;
  const params = [bookId, userEmail];
  if (chapterId !== null) {
    sql = `
      SELECT DISTINCT l.id, l.loc_id, l.name, l.typ, l.beschreibung, l.stimmung,
             l.erste_erwaehnung, l.erste_erwaehnung_page_id, p.page_name AS erste_erwaehnung_page_name
      FROM locations l
      LEFT JOIN pages p ON p.page_id = l.erste_erwaehnung_page_id
      JOIN location_chapters lc ON lc.location_id = l.id
      WHERE l.book_id = ? AND l.user_email IS ? AND lc.chapter_id = ?
    `;
    params.push(chapterId);
  }
  sql += ' ORDER BY l.sort_order, l.id';
  return db.prepare(sql).all(...params);
}

/** Kapitel-Bezüge mehrerer Orte mit Kapitelname, je Ort in Leserichtung. */
function listLocationChaptersForLocations(locationIds) {
  const { sql: idSql, values: idVals } = inClause(locationIds);
  return db.prepare(`
    SELECT lc.location_id, lc.chapter_id, c.chapter_name, lc.haeufigkeit
    FROM location_chapters lc
    LEFT JOIN chapters c ON c.chapter_id = lc.chapter_id
    WHERE lc.location_id IN ${idSql}
    ORDER BY lc.location_id, c.position
  `).all(...idVals);
}

/** Figuren mehrerer Orte; nur Figuren aus (Buch, User). Ohne ORDER BY. */
function listLocationFiguresForLocations(bookId, userEmail, locationIds) {
  const { sql: idSql, values: idVals } = inClause(locationIds);
  return db.prepare(`
    SELECT lf.location_id, f.fig_id, f.name
    FROM location_figures lf
    JOIN figures f ON f.id = lf.figure_id AND f.book_id = ? AND f.user_email IS ?
    WHERE lf.location_id IN ${idSql}
  `).all(bookId, userEmail, ...idVals);
}

const _stmtLocationFigures = db.prepare(`
    SELECT f.fig_id, f.name
    FROM location_figures lf
    JOIN figures f ON f.id = lf.figure_id AND f.book_id = ? AND f.user_email IS ?
    WHERE lf.location_id = ?
  `);

/** Figuren eines Orts; nur Figuren aus (Buch, User). Ohne ORDER BY. */
function listLocationFigures(bookId, userEmail, locationId) {
  return _stmtLocationFigures.all(bookId, userEmail, locationId);
}

const _stmtLocationIdByLocId = db.prepare(
      'SELECT id FROM locations WHERE book_id = ? AND loc_id = ? AND user_email IS ?'
    );

/** locations.id per loc_id, gescoped auf (Buch, User) — Filter von list_scenes. */
function getLocationIdByLocId(bookId, locId, userEmail) {
  return _stmtLocationIdByLocId.get(bookId, locId, userEmail);
}

const _stmtLocationByLocId = db.prepare(`
      SELECT l.id, l.loc_id, l.name, l.typ, l.beschreibung, l.stimmung,
             l.erste_erwaehnung, l.erste_erwaehnung_page_id, p.page_name AS erste_erwaehnung_page_name
      FROM locations l
      LEFT JOIN pages p ON p.page_id = l.erste_erwaehnung_page_id
      WHERE l.book_id = ? AND l.loc_id = ? AND l.user_email IS ?
    `);

/** Ort per loc_id (exakt) mit Name der Erst-Erwähnungs-Seite. */
function getLocationByLocId(bookId, locId, userEmail) {
  return _stmtLocationByLocId.get(bookId, locId, userEmail);
}

const _stmtLocationByName = db.prepare(`
      SELECT l.id, l.loc_id, l.name, l.typ, l.beschreibung, l.stimmung,
             l.erste_erwaehnung, l.erste_erwaehnung_page_id, p.page_name AS erste_erwaehnung_page_name
      FROM locations l
      LEFT JOIN pages p ON p.page_id = l.erste_erwaehnung_page_id
      WHERE l.book_id = ? AND l.user_email IS ? AND l.name LIKE ?
      ORDER BY CASE WHEN l.name = ? THEN 0 ELSE 1 END, l.sort_order, l.id
      LIMIT 1
    `);

/** Ort per Namens-Teilstring (LIKE, exakter Treffer zuerst). */
function findLocationByName(bookId, userEmail, name) {
  return _stmtLocationByName.get(bookId, userEmail, `%${name}%`, name);
}

const _stmtLocationScenes = db.prepare(`
    SELECT fs.id AS scene_id, fs.titel, fs.wertung,
           fs.chapter_id, c.chapter_name, fs.page_id, p.page_name
    FROM scene_locations sl
    JOIN figure_scenes fs ON fs.id = sl.scene_id
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fs.page_id
    WHERE sl.location_id = ? AND fs.book_id = ? AND fs.user_email IS ?
    ORDER BY fs.sort_order, fs.id
  `);

/** Szenen an einem Ort mit Kapitel- und Seitenname. */
function listLocationScenesWithPlaces(locationId, bookId, userEmail) {
  return _stmtLocationScenes.all(locationId, bookId, userEmail);
}

// ── Songs ────────────────────────────────────────────────────────────────────

/** Songs eines Buchs mit Name der Erst-Erwähnungs-Seite. Filter optional:
 *  `chapterId`, `figureId` (figures.id). */
function listSongsWithFirstPage(bookId, userEmail, { chapterId = null, figureId = null } = {}) {
  let sql = `
    SELECT s.id, s.song_uid, s.titel, s.interpret, s.genre, s.kontext_typ,
           s.beschreibung, s.stimmung, s.erste_erwaehnung,
           s.erste_erwaehnung_page_id, p.page_name AS erste_erwaehnung_page_name
    FROM songs s
    LEFT JOIN pages p ON p.page_id = s.erste_erwaehnung_page_id
    WHERE s.book_id = ? AND s.user_email = ?
  `;
  const params = [bookId, userEmail];
  if (chapterId !== null) {
    sql += ' AND s.id IN (SELECT song_id FROM song_chapters WHERE chapter_id = ?)';
    params.push(chapterId);
  }
  if (figureId !== null) {
    sql += ' AND s.id IN (SELECT song_id FROM song_figures WHERE figure_id = ?)';
    params.push(figureId);
  }
  sql += ' ORDER BY s.sort_order, s.id';
  return db.prepare(sql).all(...params);
}

/** Kapitel-Bezüge mehrerer Songs mit Kapitelname, häufigste zuerst, dann Leserichtung. */
function listSongChaptersForSongs(songIds) {
  const { sql: idSql, values: idVals } = inClause(songIds);
  return db.prepare(`
    SELECT sc.song_id, sc.chapter_id, c.chapter_name, sc.haeufigkeit
    FROM song_chapters sc
    LEFT JOIN chapters c ON c.chapter_id = sc.chapter_id
    WHERE sc.song_id IN ${idSql}
    ORDER BY sc.haeufigkeit DESC, c.position
  `).all(...idVals);
}

/** Figuren mehrerer Songs mit Song-Kontext. Ohne ORDER BY, ohne Buch-Scope
 *  (die Song-IDs sind bereits auf das Buch gefiltert). */
function listSongFiguresForSongs(songIds) {
  const { sql: idSql, values: idVals } = inClause(songIds);
  return db.prepare(`
    SELECT sf.song_id, f.fig_id, f.name, sf.kontext_typ
    FROM song_figures sf
    JOIN figures f ON f.id = sf.figure_id
    WHERE sf.song_id IN ${idSql}
  `).all(...idVals);
}

// ── Szenen ───────────────────────────────────────────────────────────────────

/** Szenen eines Buchs mit Kapitel- und Seitenname. Filter optional:
 *  `chapterId`, `pageId`, `figureId` (figures.id), `locationId` (locations.id). */
function listScenesWithPlaces(bookId, userEmail, { chapterId = null, pageId = null, figureId = null, locationId = null } = {}) {
  let sql = `
    SELECT fs.id, fs.titel, fs.wertung, fs.kommentar, fs.sort_order,
           fs.chapter_id, c.chapter_name,
           fs.page_id, p.page_name
    FROM figure_scenes fs
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fs.page_id
    WHERE fs.book_id = ? AND fs.user_email IS ?
  `;
  const params = [bookId, userEmail];
  if (chapterId !== null) { sql += ' AND fs.chapter_id = ?'; params.push(chapterId); }
  if (pageId    !== null) { sql += ' AND fs.page_id = ?';    params.push(pageId); }
  if (figureId  !== null) {
    sql += ' AND fs.id IN (SELECT scene_id FROM scene_figures WHERE figure_id = ?)';
    params.push(figureId);
  }
  if (locationId !== null) {
    sql += ' AND fs.id IN (SELECT scene_id FROM scene_locations WHERE location_id = ?)';
    params.push(locationId);
  }
  sql += ' ORDER BY fs.sort_order, fs.id';
  return db.prepare(sql).all(...params);
}

/** Figuren mehrerer Szenen. Ohne ORDER BY. */
function listSceneFiguresForScenes(sceneIds) {
  const { sql: idSql, values: idVals } = inClause(sceneIds);
  return db.prepare(`
    SELECT sf.scene_id, f.fig_id, f.name
    FROM scene_figures sf
    JOIN figures f ON f.id = sf.figure_id
    WHERE sf.scene_id IN ${idSql}
  `).all(...idVals);
}

/** Orte mehrerer Szenen. Ohne ORDER BY. */
function listSceneLocationsForScenes(sceneIds) {
  const { sql: idSql, values: idVals } = inClause(sceneIds);
  return db.prepare(`
    SELECT sl.scene_id, l.loc_id, l.name
    FROM scene_locations sl
    JOIN locations l ON l.id = sl.location_id
    WHERE sl.scene_id IN ${idSql}
  `).all(...idVals);
}

// ── Figuren ──────────────────────────────────────────────────────────────────

const _stmtFiguresWithMentions = db.prepare(`
    SELECT f.id, f.fig_id, f.name, f.kurzname, f.typ, f.rolle, f.praesenz,
           COALESCE(SUM(pfm.count), 0) AS mentions
    FROM figures f
    LEFT JOIN page_figure_mentions pfm ON pfm.figure_id = f.id
    LEFT JOIN pages p ON p.page_id = pfm.page_id AND p.book_id = f.book_id
    WHERE f.book_id = ? AND f.user_email IS ?
    GROUP BY f.id
    ORDER BY f.sort_order, f.id
  `);

/** Figuren eines Buchs mit Summe der Index-Erwähnungen. */
function listFiguresWithMentions(bookId, userEmail) {
  return _stmtFiguresWithMentions.all(bookId, userEmail);
}

module.exports = {
  listChaptersWithStats,
  listPagesWithStats,
  getPageHeader,
  listIdeenWithPlaces,
  listLocationsWithFirstPage,
  listLocationChaptersForLocations,
  listLocationFiguresForLocations,
  listLocationFigures,
  getLocationIdByLocId,
  getLocationByLocId,
  findLocationByName,
  listLocationScenesWithPlaces,
  listSongsWithFirstPage,
  listSongChaptersForSongs,
  listSongFiguresForSongs,
  listScenesWithPlaces,
  listSceneFiguresForScenes,
  listSceneLocationsForScenes,
  listFiguresWithMentions,
};
