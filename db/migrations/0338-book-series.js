'use strict';
// Buchreihen als Verbund: die Daten (Figuren, Orte, Welt-Fakten) bleiben je Buch,
// die Reihe ordnet nur Bände. Kein Besitzer-Konto an der Reihe — Rechte leiten sich
// aus den Mitglieds-Büchern ab (Besitzwechsel eines Bandes liesse eine Konto-Spalte
// veralten). Ein Buch gehört höchstens einer Reihe an (UNIQUE book_id).
//
// origin_figure_id / origin_location_id: Herkunft eines per «Aus Vorband
// übernehmen» kopierten Eintrags. SET NULL — die Kopie ist eigenständige Pflege
// des Autors und überlebt das Löschen des Vorbands.

module.exports = {
  version: 338,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS book_series (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL CHECK(length(trim(name)) > 0),
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS book_series_members (
        series_id INTEGER NOT NULL REFERENCES book_series(id) ON DELETE CASCADE,
        book_id   INTEGER NOT NULL UNIQUE REFERENCES books(book_id) ON DELETE CASCADE,
        position  INTEGER NOT NULL CHECK(position >= 1),
        PRIMARY KEY (series_id, book_id)
      );
      CREATE INDEX IF NOT EXISTS idx_book_series_members_book ON book_series_members(book_id);
    `);
    // Spalten-Check: die Datei lief in Dev-DBs schon einmal unter anderer Nummer.
    const has = (t, c) => db.prepare(`SELECT 1 FROM pragma_table_info('${t}') WHERE name = ?`).get(c);
    if (!has('figures', 'origin_figure_id')) {
      db.exec('ALTER TABLE figures ADD COLUMN origin_figure_id INTEGER REFERENCES figures(id) ON DELETE SET NULL');
    }
    if (!has('locations', 'origin_location_id')) {
      db.exec('ALTER TABLE locations ADD COLUMN origin_location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_figures_origin ON figures(origin_figure_id);
      CREATE INDEX IF NOT EXISTS idx_locations_origin ON locations(origin_location_id);
    `);
  },
};
