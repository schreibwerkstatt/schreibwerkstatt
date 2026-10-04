'use strict';
// Schauplätze: manuelle Pflege + Hierarchie (docs/schauplaetze.md).
//
// - `parent_id`         übergeordneter Schauplatz (Raum → Gebäude → Stadt). SET NULL:
//                        fällt der Elternort weg, bleibt das Kind als Wurzel stehen.
// - `manually_edited`   der Autor hat Name/Typ/Beschreibung/Stimmung/Land/Eltern
//                        korrigiert → die Komplettanalyse überschreibt diese Felder nicht.
// - `manually_created`  vom Autor angelegt → die Analyse markiert ihn nie «nicht mehr
//                        im Text» (sie hat ihn ja nie gefunden).
// - `ki_name`           der zuletzt von der Analyse gelieferte Name. Benennt der Autor
//                        einen Ort um, matcht der nächste Lauf weiter über diesen Namen,
//                        statt den Ort als verschwunden zu markieren.
module.exports = {
  version: 303,
  up(db) {
    db.exec(`ALTER TABLE locations ADD COLUMN parent_id INTEGER REFERENCES locations(id) ON DELETE SET NULL`);
    db.exec(`ALTER TABLE locations ADD COLUMN manually_edited INTEGER NOT NULL DEFAULT 0 CHECK (manually_edited IN (0, 1))`);
    db.exec(`ALTER TABLE locations ADD COLUMN manually_created INTEGER NOT NULL DEFAULT 0 CHECK (manually_created IN (0, 1))`);
    db.exec(`ALTER TABLE locations ADD COLUMN ki_name TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations(parent_id)`);
  },
};
