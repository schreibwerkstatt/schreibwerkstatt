'use strict';
// Schullaufbahn, zweite Stufe (docs/figur-lebenslauf.md, «Schullaufbahn»).
//
// figure_school_paths.klassenangaben_json: ausdrückliche Klassenangaben aus dem
//   Text («1999 war Anna in der 3. Bez»), je mit Jahr, Stufe, Klasse, Zitat und
//   page_id. Geschrieben ausschliesslich vom Job `schulweg-vorschlag` (wie
//   vorschlag_json); verglichen mit der Rechnung wird erst beim Lesen, damit ein
//   später geänderter Schulweg den Befund sofort neu bewertet.
// book_settings.handlungsjahr: Jahr, in dem die Handlung (überwiegend) spielt —
//   Angabe des Autors, NULL = keine. Der Steckbrief zeigt damit die Klassenstufe
//   zur Handlungszeit.
module.exports = {
  version: 346,
  up(db) {
    const sp = new Set(db.prepare('PRAGMA table_info(figure_school_paths)').all().map(c => c.name));
    if (!sp.has('klassenangaben_json')) db.exec('ALTER TABLE figure_school_paths ADD COLUMN klassenangaben_json TEXT');
    const bs = new Set(db.prepare('PRAGMA table_info(book_settings)').all().map(c => c.name));
    if (!bs.has('handlungsjahr')) db.exec('ALTER TABLE book_settings ADD COLUMN handlungsjahr INTEGER');
  },
};
