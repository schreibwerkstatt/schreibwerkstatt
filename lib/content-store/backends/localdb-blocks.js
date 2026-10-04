'use strict';
// Block-ID-Lookups fuer das localdb-Backend. Ausgelagert, damit localdb.js
// unter dem LOC-Cap bleibt.

const { db } = require('../../../db/connection');

// Erste Seite des Buchs (in Leserichtung wie listPages), deren HTML den Block
// traegt. instr() im SQL statt jede Seite als HTML in den Prozess zu laden —
// bei einem grossen Buch ist das der Unterschied zwischen einem Index-Scan in
// SQLite und hunderten Seiten-Loads pro Kommentar-Zaehlung.
const _pageByBidStmt = db.prepare(`
  SELECT page_id FROM pages
   WHERE book_id = ? AND instr(body_html, ?) > 0
   ORDER BY COALESCE(position, 0), page_name COLLATE NOCASE
   LIMIT 1
`);

/** { bid → page_id | null } fuer die gesuchten Block-IDs eines Buchs. */
function findPagesByBlockIds(bookId, bids) {
  const out = {};
  for (const b of bids) {
    const row = _pageByBidStmt.get(bookId, `data-bid="${b}"`);
    out[b] = row ? row.page_id : null;
  }
  return out;
}

module.exports = { findPagesByBlockIds };
