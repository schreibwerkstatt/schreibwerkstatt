'use strict';
// world_facts.manually_edited: vom Autor angelegte oder bearbeitete Aussage
// (Welt-Karte, «Aus Vorband übernehmen»). Der Full-Replace der Komplettanalyse
// (saveFaktenToDb) lässt solche Zeilen stehen und hängt nur ihre Kapitel-Brücke
// neu an; ohne die Spalte löschte jeder Lauf die Pflege des Autors.

module.exports = {
  version: 337,
  up(db) {
    // Spalten-Check: die Datei lief in Dev-DBs schon einmal unter anderer Nummer.
    if (db.prepare("SELECT 1 FROM pragma_table_info('world_facts') WHERE name = 'manually_edited'").get()) return;
    db.exec(`
      ALTER TABLE world_facts ADD COLUMN manually_edited INTEGER NOT NULL DEFAULT 0
        CHECK(manually_edited IN (0,1));
    `);
  },
};
