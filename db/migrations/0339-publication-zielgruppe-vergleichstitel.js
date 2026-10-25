'use strict';
// Zwei Buchhandels-/Exposé-Metadaten in book_publication: Zielgruppe und
// Vergleichstitel (Freitext). Sie gehoeren zum Buch, nicht zum Exposé — das
// Exposé liest sie hier wie Titel, Autor und Klappentext.

module.exports = {
  version: 339,
  up(db) {
    db.exec(`
      ALTER TABLE book_publication ADD COLUMN zielgruppe TEXT;
      ALTER TABLE book_publication ADD COLUMN vergleichstitel TEXT;
    `);
  },
};
