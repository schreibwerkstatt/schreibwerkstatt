'use strict';
// Meta-Felder der Buchliste (`GET /content/books`): Owner, Kategorie und
// Buchtyp je Buch. Eigenes Modul, weil der Handler keine Roh-SQL auf `books`
// absetzen darf (Content-Store-Regel, Muster db/sources/citations.js).

const { db } = require('./connection');

const _stmt = db.prepare(`
  SELECT b.book_id, b.owner_email, b.category_id, s.buchtyp, s.book_id AS settings_book_id
  FROM books b
  LEFT JOIN book_settings s ON s.book_id = b.book_id
`);

/**
 * @returns {Array<{ book_id:number, owner_email:string|null, category_id:number|null,
 *   buchtyp:string|null, has_settings:boolean }>}
 */
function listBookListMeta() {
  return _stmt.all().map(r => ({
    book_id: r.book_id,
    owner_email: r.owner_email,
    category_id: r.category_id,
    buchtyp: r.buchtyp,
    has_settings: r.settings_book_id != null,
  }));
}

module.exports = { listBookListMeta };
