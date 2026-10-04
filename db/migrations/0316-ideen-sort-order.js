'use strict';
// Manuelle Reihenfolge der Ideen innerhalb einer Board-Zelle (Bahn × Stufe),
// docs/ideen-board.md, Sortierung „Manuell".
//
// `sort_order` ordnet nur innerhalb derselben Zelle; der Board-Drag schreibt die
// Zelle als Ganzes neu (1..n). 0 heisst „nie einsortiert" — eine neue Idee steht
// damit oben in ihrer Zelle, und unter mehreren nie einsortierten entscheidet
// `created_at DESC`. NOT NULL statt NULL-als-Marker: die Ordnung ist eine Zahl,
// kein Ja/Nein daneben.
module.exports = {
  version: 316,
  up(db) {
    const cols = db.prepare('PRAGMA table_info(ideen)').all().map(c => c.name);
    if (!cols.includes('sort_order')) {
      db.exec('ALTER TABLE ideen ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
    }
  },
};
