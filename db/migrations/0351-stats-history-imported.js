'use strict';
// Import-Zuwachs in der Snapshot-Historie (docs/my-stats.md „Importe"): je Buch
// die bis zu diesem Snapshot aufsummierten Zeichen/Wörter/Abschnitte, die ein
// Import (Ordner, Manuskript, .swbook, WordPress, HubSpot) gebracht hat.
// Kumulativ, damit jede Differenz zweier Snapshots den Import ihres Intervalls
// direkt abziehen kann — auch über die ausgedünnte Monats-Historie hinweg.
// Altbestand bleibt 0: frühere Importe sind nachträglich nicht bestimmbar.
const COLS = ['imported_chars', 'imported_words', 'imported_pages'];

module.exports = {
  version: 351,
  up(db) {
    const cols = new Set(db.prepare('PRAGMA table_info(book_stats_history)').all().map(c => c.name));
    for (const c of COLS) {
      if (!cols.has(c)) db.exec(`ALTER TABLE book_stats_history ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
    }
  },
};
