'use strict';
// Berufsweg und Hobbys der Figuren (docs/figur-lebenslauf.md, «Berufsweg und Hobbys»).
//
// Zwei Listen, eine Mechanik (db/figure-stationen.js): eine Zeile pro Station
// bzw. Hobby, an figures.id. Ein Vorschlag des Jobs `stationen-vorschlag` ist
// eine Zeile mit status 'vorschlag' samt Beleg (zitat, page_id, begruendung);
// «Übernehmen» setzt status 'aktiv' + source 'ki', «Verwerfen» löscht sie. Der
// Autor legt direkt 'aktiv' + source 'autor' an. Der Job ersetzt nur Zeilen mit
// status 'vorschlag' — was der Autor hat, fasst er nie an.
//
// Zeitraum als Jahr + optional Monat, beidseitig offen: von_jahr NULL = Beginn
// unbekannt, bis_jahr NULL = läuft noch bzw. Ende unbekannt. Ohne von_jahr und
// bis_jahr ist der Eintrag undatiert (zählt im Steckbrief, nicht am Stichtag).
//
// CASCADE an figure_id: die Figurenzeile bleibt über Komplettanalysen stabil
// (Reconcile matcht in place); fällt die Figur, fallen ihre Stationen mit.
// SET NULL an page_id: der Beleg ist Komfort, die Station gehört dem Autor.
module.exports = {
  version: 356,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS figure_jobs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        figure_id   INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        status      TEXT NOT NULL DEFAULT 'aktiv' CHECK(status IN ('aktiv','vorschlag')),
        source      TEXT NOT NULL DEFAULT 'autor' CHECK(source IN ('autor','ki')),
        art         TEXT NOT NULL DEFAULT 'beruf' CHECK(art IN ('ausbildung','beruf')),
        taetigkeit  TEXT NOT NULL,
        arbeitgeber TEXT,
        ort         TEXT,
        von_jahr    INTEGER,
        von_monat   INTEGER CHECK(von_monat IS NULL OR von_monat BETWEEN 1 AND 12),
        bis_jahr    INTEGER,
        bis_monat   INTEGER CHECK(bis_monat IS NULL OR bis_monat BETWEEN 1 AND 12),
        notiz       TEXT,
        zitat       TEXT,
        page_id     INTEGER REFERENCES pages(page_id) ON DELETE SET NULL,
        begruendung TEXT,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_figure_jobs_figure ON figure_jobs(figure_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_figure_jobs_page ON figure_jobs(page_id)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS figure_hobbies (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        figure_id   INTEGER NOT NULL REFERENCES figures(id) ON DELETE CASCADE,
        status      TEXT NOT NULL DEFAULT 'aktiv' CHECK(status IN ('aktiv','vorschlag')),
        source      TEXT NOT NULL DEFAULT 'autor' CHECK(source IN ('autor','ki')),
        hobby       TEXT NOT NULL,
        ort         TEXT,
        von_jahr    INTEGER,
        von_monat   INTEGER CHECK(von_monat IS NULL OR von_monat BETWEEN 1 AND 12),
        bis_jahr    INTEGER,
        bis_monat   INTEGER CHECK(bis_monat IS NULL OR bis_monat BETWEEN 1 AND 12),
        notiz       TEXT,
        zitat       TEXT,
        page_id     INTEGER REFERENCES pages(page_id) ON DELETE SET NULL,
        begruendung TEXT,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_figure_hobbies_figure ON figure_hobbies(figure_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_figure_hobbies_page ON figure_hobbies(page_id)');
  },
};
