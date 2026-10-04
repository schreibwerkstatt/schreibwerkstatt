// Lokale `books`-Tabelle: FK-Target fuer alle book_id-tragenden Tabellen.
// `book_id` ist der Buch-Identifier und gleichzeitig PRIMARY KEY
// (analog pages.page_id und chapters.chapter_id). Discovery-Hooks (sync.js,
// db/pages.js) halten die Tabelle aktuell, ohne dass jede Beruehrung einen
// API-Roundtrip braucht. Handler schreiben hier nie direkt — der Eigentuemer
// laeuft ueber lib/content-store#setBookOwner.
const { db } = require('./connection');
const logger = require('../logger');

const _stmtUpsertBook = db.prepare(`
  INSERT INTO books (book_id, name, slug, created_at, updated_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    name=excluded.name, slug=excluded.slug,
    updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at
`);

// Variante ohne Slug — Frontend-POSTs liefern nur book_id+book_name. Slug
// nicht mit NULL ueberschreiben, falls schon befuellt.
const _stmtUpsertBookByName = db.prepare(`
  INSERT INTO books (book_id, name, slug, created_at, updated_at, last_seen_at)
  VALUES (?, ?, NULL, ?, ?, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    name=excluded.name, updated_at=excluded.updated_at,
    last_seen_at=excluded.last_seen_at
`);

const _stmtGetName = db.prepare('SELECT name FROM books WHERE book_id = ?');

function upsertBook(b) {
  if (!b || !b.id) return;
  const now = new Date().toISOString();
  _stmtUpsertBook.run(b.id, b.name || `Buch ${b.id}`, b.slug || null, now, now, now);
}

function upsertBookByName(bookId, name) {
  const id = parseInt(bookId);
  if (!Number.isInteger(id) || id <= 0) return;
  if (!name) return;
  const now = new Date().toISOString();
  _stmtUpsertBookByName.run(id, name, now, now, now);
}

// `books.owner_email` setzen. `onlyIfUnset` laesst einen vorhandenen Eigentuemer
// stehen (Anlage-Pfade, idempotent). Liefert, ob eine Zeile geaendert wurde.
const _stmtSetOwner = db.prepare('UPDATE books SET owner_email = ? WHERE book_id = ?');
const _stmtSetOwnerIfUnset = db.prepare('UPDATE books SET owner_email = COALESCE(owner_email, ?) WHERE book_id = ?');
function setBookOwner(bookId, email, { onlyIfUnset = false } = {}) {
  return (onlyIfUnset ? _stmtSetOwnerIfUnset : _stmtSetOwner).run(email, bookId).changes > 0;
}

function getBookName(bookId) {
  const r = _stmtGetName.get(parseInt(bookId));
  return r ? r.name : null;
}

module.exports = { upsertBook, upsertBookByName, setBookOwner, getBookName };
