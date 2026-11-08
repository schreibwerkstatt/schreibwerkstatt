'use strict';
// Schauplatz-Identität und Feld-Schutz über Komplettanalyse-Läufe
// (docs/schauplaetze.md):
//
// location_aliases: Namen, unter denen ein Katalogort im Text ebenfalls steht —
//   entstanden beim manuellen Zusammenführen (Name/ki_name der weggemergten
//   Quelle). Der Cross-Run-Abgleich (planOrteMatch) liest sie, damit ein
//   zusammengeführter Ort beim nächsten Lauf nicht als eigener Eintrag
//   wiederkehrt. Muster figure_aliases (Migration 321): Anzeigeform speichern,
//   beim Lesen normalisieren; CASCADE mit Ort und Buch.
//
// locations.manual_fields: JSON-Array der vom Autor korrigierten Stammdatenfelder
//   (Teilmenge von name/typ/beschreibung/stimmung/land). Nur diese Felder schützt
//   der Analyse-Schreibpfad; `manually_edited` bleibt als «mindestens ein Feld
//   geschützt» erhalten. Backfill: bisher geschützte Zeilen schützen alle fünf.
//
// locations.ki_typ / ki_beschreibung / ki_stimmung / ki_land: der Wert, den die
//   Analyse zuletzt geliefert hat (Muster ki_name). «Analyse-Werte übernehmen»
//   stellt daraus wieder her. Backfill nur für ungeschützte Analyse-Orte — bei
//   geschützten ist der letzte Analysewert unbekannt und bleibt NULL.
module.exports = {
  version: 360,
  up(db) {
    const cols = new Set(db.prepare('PRAGMA table_info(locations)').all().map(c => c.name));
    for (const c of ['manual_fields', 'ki_typ', 'ki_beschreibung', 'ki_stimmung', 'ki_land']) {
      if (!cols.has(c)) db.exec(`ALTER TABLE locations ADD COLUMN ${c} TEXT`);
    }
    db.exec(`UPDATE locations
                SET manual_fields = '["name","typ","beschreibung","stimmung","land"]'
              WHERE manually_edited = 1 AND manual_fields IS NULL`);
    db.exec(`UPDATE locations
                SET ki_name = COALESCE(ki_name, name), ki_typ = typ, ki_beschreibung = beschreibung,
                    ki_stimmung = stimmung, ki_land = land
              WHERE manually_edited = 0 AND manually_created = 0`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS location_aliases (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        location_id INTEGER NOT NULL REFERENCES locations(id)    ON DELETE CASCADE,
        book_id     INTEGER NOT NULL REFERENCES books(book_id)   ON DELETE CASCADE,
        alias       TEXT    NOT NULL CHECK(length(trim(alias)) > 0),
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(location_id, alias)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_location_aliases_book ON location_aliases(book_id)');
  },
};
