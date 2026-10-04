'use strict';
// song_scenes entfernen. Die Komplettanalyse hat die Bruecke Song↔Szene nie
// befuellt (weder Prompt noch Schema extrahieren sie); Zeilen kamen nur aus
// .swbook-Importen und Szenen-Merges, die sie weitertrugen. Nach dem Umbau auf
// identitaetsstabile Songs (db/songs.js, Abgleich ueber Titel+Interpret) waere
// sie nur noch eine leere Tabelle mit Lese- und Merge-Pfaden ohne Inhalt.
module.exports = {
  version: 307,
  up(db) {
    db.exec('DROP INDEX IF EXISTS idx_song_scenes_song');
    db.exec('DROP TABLE IF EXISTS song_scenes');
  },
};
