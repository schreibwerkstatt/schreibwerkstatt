'use strict';
// Abfragen der Buch-Chat-Tools `list_continuity_issues` und `get_timeline`
// (routes/jobs/book-chat-tools/tools-timeline.js): jüngster Kontinuitätscheck,
// Issues, Zeitstrahl-Events und die Figuren-/Kapitel-/Seiten-Bridges. Das Tool
// führt selbst kein SQL aus; Kapitel-/Seitennamen kommen per JOIN von hier
// (CLAUDE.md „Content-Store-Facade als einziger Eintrittspunkt"). IN-Listen
// werden hier gebaut; eine leere Liste matcht nichts (`inClause` → `(NULL)`).

const { db } = require('../connection');
require('../migrations');
const { inClause } = require('../../lib/validate');

// ── list_continuity_issues ──────────────────────────────────────────────────

const _stmtLatestContinuityCheck = db.prepare(`
    SELECT id, checked_at, summary, model
    FROM continuity_checks
    WHERE book_id = ? AND user_email IS ?
    ORDER BY checked_at DESC
    LIMIT 1
  `);

/** Jüngster Kontinuitätscheck von (Buch, User), NULL-sicher. */
function getLatestContinuityCheck(bookId, userEmail) {
  return _stmtLatestContinuityCheck.get(bookId, userEmail);
}

const _stmtContinuityIssues = db.prepare(`
    SELECT id, schwere, typ, beschreibung, stelle_a, stelle_b, empfehlung, sort_order
    FROM continuity_issues
    WHERE check_id = ? AND dismissed = 0
    ORDER BY sort_order, id
  `);

/** Issues eines Checks in Anzeige-Reihenfolge — ohne die vom Autor als „kein Fehler"
 *  verworfenen: der Buch-Chat soll einen bekannten Fehlalarm nicht als Problem nennen. */
function listContinuityIssuesForCheck(checkId) {
  return _stmtContinuityIssues.all(checkId);
}

/** Figuren-Bezüge von Kontinuitäts-Issues; Name aus figures, sonst Freitext. */
function listContinuityIssueFigures(issueIds) {
  const { sql: idSql, values: idVals } = inClause(issueIds);
  return db.prepare(`
    SELECT cif.issue_id, COALESCE(f.fig_id, NULL) AS fig_id,
           COALESCE(f.name, cif.figur_name) AS name
    FROM continuity_issue_figures cif
    LEFT JOIN figures f ON f.id = cif.figure_id
    WHERE cif.issue_id IN ${idSql}
    ORDER BY cif.issue_id, cif.sort_order
  `).all(...idVals);
}

/** Kapitel-Bezüge von Kontinuitäts-Issues mit Kapitelname (NULL bei gelöschtem Kapitel). */
function listContinuityIssueChapters(issueIds) {
  const { sql: idSql, values: idVals } = inClause(issueIds);
  return db.prepare(`
    SELECT cic.issue_id, cic.chapter_id, c.chapter_name
    FROM continuity_issue_chapters cic
    LEFT JOIN chapters c ON c.chapter_id = cic.chapter_id
    WHERE cic.issue_id IN ${idSql}
    ORDER BY cic.issue_id, cic.sort_order
  `).all(...idVals);
}

// ── get_timeline ────────────────────────────────────────────────────────────

const _stmtTimelineEvents = db.prepare(`
    SELECT id, datum, ereignis, typ, bedeutung
    FROM zeitstrahl_events
    WHERE book_id = ? AND user_email = ?
    ORDER BY sort_order, id
  `);

/** Zeitstrahl-Events von (Buch, User) — `user_email = ?`, nicht NULL-sicher. */
function listTimelineEvents(bookId, userEmail) {
  return _stmtTimelineEvents.all(bookId, userEmail);
}

/** Figuren-Bezüge von Zeitstrahl-Events; Name aus figures, sonst Freitext. */
function listTimelineEventFigures(eventIds) {
  const { sql: idSql, values: idVals } = inClause(eventIds);
  return db.prepare(`
    SELECT zef.event_id, f.fig_id, COALESCE(f.name, zef.figur_name) AS name
    FROM zeitstrahl_event_figures zef
    LEFT JOIN figures f ON f.id = zef.figure_id
    WHERE zef.event_id IN ${idSql}
    ORDER BY zef.event_id, zef.sort_order
  `).all(...idVals);
}

/** Kapitel-Bezüge von Zeitstrahl-Events mit Kapitelname. */
function listTimelineEventChapters(eventIds) {
  const { sql: idSql, values: idVals } = inClause(eventIds);
  return db.prepare(`
    SELECT zec.event_id, zec.chapter_id, c.chapter_name
    FROM zeitstrahl_event_chapters zec
    LEFT JOIN chapters c ON c.chapter_id = zec.chapter_id
    WHERE zec.event_id IN ${idSql}
    ORDER BY zec.event_id, zec.sort_order
  `).all(...idVals);
}

/** Seiten-Bezüge von Zeitstrahl-Events mit Seitenname. */
function listTimelineEventPages(eventIds) {
  const { sql: idSql, values: idVals } = inClause(eventIds);
  return db.prepare(`
    SELECT zep.event_id, zep.page_id, p.page_name
    FROM zeitstrahl_event_pages zep
    LEFT JOIN pages p ON p.page_id = zep.page_id
    WHERE zep.event_id IN ${idSql}
    ORDER BY zep.event_id, zep.sort_order
  `).all(...idVals);
}

// ── get_figure_age ──────────────────────────────────────────────────────────
// Gleiche Vorrangregel wie lib/figure-years.js: der konsolidierte Zeitstrahl ist die
// kanonische Quelle; erst wenn für (Buch, User) keiner existiert, die rohen
// figure_events. Zwei Quellen nebeneinander lieferten dasselbe Ereignis doppelt.

const _stmtHasZeitstrahl = db.prepare(
  'SELECT 1 FROM zeitstrahl_events WHERE book_id = ? AND user_email = ? LIMIT 1'
);

function _hasZeitstrahl(bookId, userEmail) {
  return !!_stmtHasZeitstrahl.get(bookId, userEmail || '');
}

const _stmtZsEventsLike = db.prepare(`
    SELECT ereignis, datum, datum_year AS y, datum_month AS m, datum_day AS d,
           datum_ende_year AS ye, datum_unsicher AS unsicher, 'zeitstrahl' AS quelle
    FROM zeitstrahl_events
    WHERE book_id = ? AND user_email = ? AND datum_year IS NOT NULL
      AND ereignis LIKE ? ESCAPE '\\'
    ORDER BY sort_order, id
    LIMIT ?
  `);
const _stmtFigEventsLike = db.prepare(`
    SELECT fe.ereignis, fe.datum, fe.datum_year AS y, fe.datum_month AS m, fe.datum_day AS d,
           fe.datum_ende_year AS ye, fe.datum_unsicher AS unsicher, 'figure_events' AS quelle
    FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    WHERE f.book_id = ? AND f.user_email = ? AND fe.datum_year IS NOT NULL
      AND fe.ereignis LIKE ? ESCAPE '\\'
    ORDER BY fe.datum_year, fe.sort_order, fe.id
    LIMIT ?
  `);

/** Datierte Ereignisse von (Buch, User), deren Text `needle` enthält (Teilstring,
 *  case-insensitive für ASCII). Unsicher datierte bleiben drin, `unsicher` markiert sie. */
function findDatedEvents(bookId, userEmail, needle, limit = 10) {
  const like = '%' + String(needle).replace(/[\\%_]/g, c => '\\' + c) + '%';
  const stmt = _hasZeitstrahl(bookId, userEmail) ? _stmtZsEventsLike : _stmtFigEventsLike;
  return stmt.all(bookId, userEmail || '', like, limit);
}

const _stmtZsBirth = db.prepare(`
    SELECT ze.datum_year AS y, ze.datum_month AS m, ze.datum_day AS d
    FROM zeitstrahl_event_figures zef
    JOIN zeitstrahl_events ze ON ze.id = zef.event_id
    WHERE zef.figure_id = ? AND ze.book_id = ? AND ze.user_email = ?
      AND ze.subtyp = 'geburt' AND ze.datum_unsicher = 0 AND ze.datum_year IS NOT NULL
    ORDER BY ze.datum_year
    LIMIT 1
  `);
const _stmtFigBirth = db.prepare(`
    SELECT datum_year AS y, datum_month AS m, datum_day AS d
    FROM figure_events
    WHERE figure_id = ? AND subtyp = 'geburt' AND datum_unsicher = 0 AND datum_year IS NOT NULL
    ORDER BY datum_year
    LIMIT 1
  `);

/** Frühestes sicher datiertes Geburts-Ereignis einer Figur ({y,m,d}) oder undefined.
 *  Quelle nach derselben Vorrangregel wie findDatedEvents. */
function getBirthEvent(bookId, userEmail, figureId) {
  return _hasZeitstrahl(bookId, userEmail)
    ? _stmtZsBirth.get(figureId, bookId, userEmail || '')
    : _stmtFigBirth.get(figureId);
}

module.exports = {
  findDatedEvents,
  getBirthEvent,
  getLatestContinuityCheck,
  listContinuityIssuesForCheck,
  listContinuityIssueFigures,
  listContinuityIssueChapters,
  listTimelineEvents,
  listTimelineEventFigures,
  listTimelineEventChapters,
  listTimelineEventPages,
};
