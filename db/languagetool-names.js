'use strict';
// Eigennamen eines Buchs (Figuren + Schauplaetze) als erlaubte Woerter fuer
// die LanguageTool-Pruefung. Bewusst ohne User-Filter: wer das Buch pruefen
// darf, sieht dessen Figuren und Orte ohnehin, und Mitarbeiter ohne eigene
// Katalog-Zeilen sollen dieselben Namen nicht als Tippfehler sehen.

const { db } = require('./connection');

const _stmtFigures = db.prepare(
  `SELECT name, kurzname FROM figures WHERE book_id = ?`
);
const _stmtLocations = db.prepare(
  `SELECT name FROM locations WHERE book_id = ?`
);

// Rohnamen; die Zerlegung in Einzelwoerter macht lib/languagetool-filter.js.
function listBookNames(bookId) {
  if (!bookId) return [];
  const out = [];
  for (const f of _stmtFigures.all(bookId)) {
    if (f.name) out.push(f.name);
    if (f.kurzname) out.push(f.kurzname);
  }
  for (const l of _stmtLocations.all(bookId)) if (l.name) out.push(l.name);
  return out;
}

module.exports = { listBookNames };
