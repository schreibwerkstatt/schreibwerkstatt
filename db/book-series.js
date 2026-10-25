'use strict';
// Buchreihen (`book_series` + `book_series_members`): die Reihe ordnet nur Bände,
// Figuren/Orte/Welt-Fakten bleiben je Buch. Positionen sind lückenlos 1..n; jede
// Mitglieds-Änderung nummeriert neu. Eine Reihe ohne Band wird gelöscht.
// Die Buchnamen kommen per JOIN zur Lesezeit (Namens-JOIN gehört nach db/, nicht
// in den Handler — Content-Store-Regel).

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');

const MAX_NAME = 200;

class SeriesError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function _name(raw) {
  const name = String(raw ?? '').trim();
  if (!name) throw new SeriesError('NAME_REQUIRED');
  if (name.length > MAX_NAME) throw new SeriesError('NAME_TOO_LONG');
  return name;
}

const _stmtSeriesOf = db.prepare('SELECT series_id FROM book_series_members WHERE book_id = ?');
function seriesIdOfBook(bookId) {
  return _stmtSeriesOf.get(bookId)?.series_id ?? null;
}

/** Bände einer Reihe in Reihenfolge: [{ book_id, name, position }]. */
function listSeriesMembers(seriesId) {
  return db.prepare(`
    SELECT m.book_id, b.name, m.position
      FROM book_series_members m JOIN books b ON b.book_id = m.book_id
     WHERE m.series_id = ? ORDER BY m.position`).all(seriesId);
}

/** Reihe eines Buchs mit Bänden, oder null. */
function getSeriesForBook(bookId) {
  const seriesId = seriesIdOfBook(bookId);
  if (seriesId == null) return null;
  const s = db.prepare('SELECT id, name FROM book_series WHERE id = ?').get(seriesId);
  const members = listSeriesMembers(seriesId);
  const own = members.find(m => m.book_id === bookId);
  return { id: s.id, name: s.name, position: own?.position ?? null, members };
}

/** EPUB-Reihenfelder eines Buchs aus der Reihe ({ series, series_index }) oder null. */
function seriesMetaForBook(bookId) {
  const row = db.prepare(`
    SELECT s.name, m.position FROM book_series_members m JOIN book_series s ON s.id = m.series_id
     WHERE m.book_id = ?`).get(bookId);
  return row ? { series: row.name, series_index: String(row.position) } : null;
}

/** Reihen, in denen mindestens eines der Bücher steht (Auswahl «Reihe beitreten»). */
function listSeriesForBooks(bookIds) {
  const ids = [...new Set(bookIds || [])].filter(Number.isInteger);
  if (!ids.length) return [];
  const rows = db.prepare(`
    SELECT DISTINCT s.id, s.name FROM book_series s
      JOIN book_series_members m ON m.series_id = s.id
     WHERE m.book_id IN (${ids.map(() => '?').join(',')})
     ORDER BY s.name COLLATE NOCASE`).all(...ids);
  return rows.map(r => ({ ...r, members: listSeriesMembers(r.id) }));
}

function _renumber(seriesId, orderedBookIds) {
  const upd = db.prepare('UPDATE book_series_members SET position = ? WHERE series_id = ? AND book_id = ?');
  orderedBookIds.forEach((bid, i) => upd.run(i + 1, seriesId, bid));
  db.prepare(`UPDATE book_series SET updated_at = ${NOW_ISO_SQL} WHERE id = ?`).run(seriesId);
}

/** Neue Reihe mit diesem Buch als Band 1. @returns {number} seriesId */
function createSeriesWithBook(bookId, rawName) {
  const name = _name(rawName);
  return db.transaction(() => {
    if (seriesIdOfBook(bookId) != null) throw new SeriesError('ALREADY_IN_SERIES', 409);
    const seriesId = db.prepare(`
      INSERT INTO book_series (name, created_at, updated_at) VALUES (?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})`)
      .run(name).lastInsertRowid;
    db.prepare('INSERT INTO book_series_members (series_id, book_id, position) VALUES (?, ?, 1)').run(seriesId, bookId);
    return seriesId;
  })();
}

/** Buch als letzten Band in eine bestehende Reihe aufnehmen. */
function joinSeries(bookId, seriesId) {
  db.transaction(() => {
    if (!db.prepare('SELECT 1 FROM book_series WHERE id = ?').get(seriesId)) throw new SeriesError('NOT_FOUND', 404);
    if (seriesIdOfBook(bookId) != null) throw new SeriesError('ALREADY_IN_SERIES', 409);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM book_series_members WHERE series_id = ?').get(seriesId);
    db.prepare('INSERT INTO book_series_members (series_id, book_id, position) VALUES (?, ?, ?)').run(seriesId, bookId, n + 1);
    db.prepare(`UPDATE book_series SET updated_at = ${NOW_ISO_SQL} WHERE id = ?`).run(seriesId);
  })();
}

/** Buch aus seiner Reihe nehmen; die übrigen rücken auf, eine leere Reihe fällt weg. */
function leaveSeries(bookId) {
  db.transaction(() => {
    const seriesId = seriesIdOfBook(bookId);
    if (seriesId == null) return;
    db.prepare('DELETE FROM book_series_members WHERE book_id = ?').run(bookId);
    const rest = listSeriesMembers(seriesId).map(m => m.book_id);
    if (rest.length) _renumber(seriesId, rest);
    else db.prepare('DELETE FROM book_series WHERE id = ?').run(seriesId);
  })();
}

function renameSeries(seriesId, rawName) {
  const name = _name(rawName);
  db.prepare(`UPDATE book_series SET name = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?`).run(name, seriesId);
}

/** Reihenfolge setzen; `bookIds` muss genau die Bände der Reihe enthalten. */
function reorderSeries(seriesId, bookIds) {
  db.transaction(() => {
    const current = listSeriesMembers(seriesId).map(m => m.book_id);
    const next = (bookIds || []).map(Number);
    const same = next.length === current.length && new Set(next).size === next.length
      && next.every(id => current.includes(id));
    if (!same) throw new SeriesError('INVALID_ORDER');
    _renumber(seriesId, next);
  })();
}

/** Vorbände eines Buchs (kleinere Position), nächster zuerst. */
function listPrequels(bookId) {
  const s = getSeriesForBook(bookId);
  if (!s) return [];
  return s.members.filter(m => m.position < s.position).reverse();
}

module.exports = {
  SeriesError,
  seriesIdOfBook,
  getSeriesForBook,
  seriesMetaForBook,
  listSeriesMembers,
  listSeriesForBooks,
  createSeriesWithBook,
  joinSeries,
  leaveSeries,
  renameSeries,
  reorderSeries,
  listPrequels,
};
