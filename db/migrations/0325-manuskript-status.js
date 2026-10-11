'use strict';
// Bearbeitungsstand fuer alle Buchtypen (docs/bearbeitungsstand.md).
//
// `page_editorial_status` trug bisher nur die redaktionelle Kette journalistischer
// Buecher. Nicht-journalistische Buecher bekommen eine eigene Manuskript-Kette
// (rohfassung → ueberarbeitet → redigiert → final) in DERSELBEN Tabelle: Frische-
// Anker, Route und Organizer-Plakette sind dieselbe Mechanik, nur die Stufen
// heissen anders. Welche Kette gilt, entscheidet der Buchtyp beim Schreiben
// (db/redaktion.js#statusChain) — der CHECK kennt die Vereinigung beider.
// SQLite aendert CHECKs nicht per ALTER → Recreate.
//
// `page_editorial_status_events`: Verlauf jeder Stufen-Aenderung (status NULL =
// Stufe entfernt). Quelle der Zeitreihe in der Buchstatistik — die Tabelle oben
// haelt nur den aktuellen Stand. Kein book_id: der Verlauf folgt der Seite, das
// Buch kommt zur Lesezeit aus `pages` (ein verschobener Abschnitt nimmt seine
// Geschichte mit). Seed: je bestehender Stufe ein Ereignis zu ihrem updated_at.

const STATUS_SQL = "'roh','gegengelesen','schlussredigiert','freigegeben','rohfassung','ueberarbeitet','redigiert','final'";

module.exports = {
  version: 325,
  fkOff: true,
  up(db) {
    db.exec(`
      DROP TABLE IF EXISTS page_editorial_status_new;
      CREATE TABLE page_editorial_status_new (
        page_id     INTEGER PRIMARY KEY REFERENCES pages(page_id) ON DELETE CASCADE,
        book_id     INTEGER NOT NULL REFERENCES books(book_id)    ON DELETE CASCADE,
        status      TEXT    NOT NULL
                      CHECK(status IN (${STATUS_SQL})),
        note        TEXT,
        content_updated_at TEXT,
        updated_by  TEXT    REFERENCES app_users(email) ON DELETE SET NULL,
        updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      INSERT INTO page_editorial_status_new
        (page_id, book_id, status, note, content_updated_at, updated_by, updated_at)
        SELECT page_id, book_id, status, note, content_updated_at, updated_by, updated_at
          FROM page_editorial_status;
      DROP TABLE page_editorial_status;
      ALTER TABLE page_editorial_status_new RENAME TO page_editorial_status;
      CREATE INDEX IF NOT EXISTS idx_page_editorial_status_book ON page_editorial_status(book_id);
      CREATE INDEX IF NOT EXISTS idx_page_editorial_status_by   ON page_editorial_status(updated_by);

      CREATE TABLE IF NOT EXISTS page_editorial_status_events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id  INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        status   TEXT CHECK(status IS NULL OR status IN (${STATUS_SQL})),
        at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_page_editorial_status_events_page
        ON page_editorial_status_events(page_id, at);

      INSERT INTO page_editorial_status_events (page_id, status, at)
        SELECT page_id, status, updated_at FROM page_editorial_status;
    `);
  },
};
