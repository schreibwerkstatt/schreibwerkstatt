'use strict';
// Ideen-Stufen pro Buch (docs/ideen-board.md, „Stufen pro Buch").
//
// `book_settings.ideen_stages` haelt die AKTIVEN Stufen als Komma-Text in
// kanonischer Reihenfolge (lib/ideen-status.js#serializeIdeeStages). `offen`
// und `erledigt` stehen immer drin; `in_arbeit` und `verworfen` schaltet das
// Buch zu. NULL heisst „nie eingestellt" und liest sich als alle vier Stufen —
// ein bestehendes Buch sieht sein Board unveraendert.
//
// Kein CHECK auf den Inhalt: die Liste ist eine Teilmenge, kein Enum, und der
// einzige Schreibpfad normalisiert ueber die SSoT.
module.exports = {
  version: 315,
  up(db) {
    const cols = db.prepare('PRAGMA table_info(book_settings)').all().map(c => c.name);
    if (!cols.includes('ideen_stages')) {
      db.exec('ALTER TABLE book_settings ADD COLUMN ideen_stages TEXT');
    }
  },
};
