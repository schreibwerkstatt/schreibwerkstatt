'use strict';
// Buch-Operationen des localdb-Backends (Domain-Shape `_bookRow`). Ausgelagert,
// damit localdb.js unter dem LOC-Cap bleibt.

const { db } = require('../../../db/connection');
const { META_LIMITS } = require('../../publication-meta');
const { _nowIso, _notFound } = require('./localdb-util');

function _bookRow(r, bookSlug = null) {
  if (!r) return null;
  return {
    id: r.book_id,
    name: r.name || '',
    slug: r.slug || null,
    description: r.description || '',
    updated_at: r.updated_at || null,
    created_at: r.created_at || null,
  };
}

// Die Buchbeschreibung ist der Klappentext und lebt einzig in
// book_publication.description (Publikation-Tab, EPUB, PDF-Umschlag, Exposé).
// `books` hat keine eigene Beschreibung; das Feld `description` der Buch-Form
// ist ein Durchgriff auf die Publikationsdaten.
const _BOOK_SELECT = `
  SELECT b.book_id, b.name, b.slug, COALESCE(bp.description, '') AS description,
         b.created_at, b.updated_at, b.owner_email
    FROM books b
    LEFT JOIN book_publication bp ON bp.book_id = b.book_id`;

function _setDescription(bookId, description, now) {
  db.prepare(`
    INSERT INTO book_publication (book_id, description, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(book_id) DO UPDATE SET description = excluded.description, updated_at = excluded.updated_at
  `).run(bookId, String(description).slice(0, META_LIMITS.description), now, now);
}

async function listBooks(_ctx) {
  const rows = db.prepare(`${_BOOK_SELECT} ORDER BY b.name COLLATE NOCASE`).all();
  return rows.map(r => _bookRow(r));
}

async function loadBook(bookId, _ctx) {
  const r = db.prepare(`${_BOOK_SELECT} WHERE b.book_id = ?`).get(bookId);
  if (!r) throw _notFound('Book', bookId);
  return _bookRow(r);
}

async function createBook({ name, description, owner_email = null }, _ctx) {
  const now = _nowIso();
  const bookId = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO books (name, owner_email, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(name, owner_email, now, now);
    if (description) _setDescription(result.lastInsertRowid, description, now);
    return result.lastInsertRowid;
  })();
  return loadBook(bookId);
}

async function updateBook(bookId, body, _ctx) {
  const hasName = typeof body?.name === 'string';
  const hasDesc = typeof body?.description === 'string';
  if (!hasName && !hasDesc) {
    const err = new Error('updateBook called without changes');
    err.code = 'EMPTY_BODY';
    throw err;
  }
  const now = _nowIso();
  db.transaction(() => {
    const result = hasName
      ? db.prepare(`UPDATE books SET name = ?, updated_at = ? WHERE book_id = ?`).run(body.name, now, bookId)
      : db.prepare(`UPDATE books SET updated_at = ? WHERE book_id = ?`).run(now, bookId);
    if (!result.changes) throw _notFound('Book', bookId);
    if (hasDesc) _setDescription(bookId, body.description, now);
  })();
  return loadBook(bookId);
}

async function deleteBook(bookId, _ctx) {
  const result = db.prepare(`DELETE FROM books WHERE book_id = ?`).run(bookId);
  if (!result.changes) throw _notFound('Book', bookId);
  return { ok: true };
}

module.exports = { listBooks, loadBook, createBook, updateBook, deleteBook };
