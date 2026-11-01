'use strict';
// Nutzungs-Event-Log (docs/usage-events.md): eine Zeile pro Ereignis, nur
// anhaengend. Die Zaehler in user_feature_usage bleiben fuer die Palette; hier
// liegt die Zeitachse, aus der die Admin-Auswertung Trends, Trichter und
// Kohorten rechnet. Kein Textinhalt — `meta_json` traegt nur die im Katalog
// erlaubten kategorialen Felder.
//
// user_email CASCADE: Verhalten eines geloeschten Kontos ist personenbezogen
// und faellt mit. book_id SET NULL: das Ereignis bleibt fuer die Statistik,
// nur der Bezug auf das geloeschte Buch faellt.

module.exports = {
  version: 349,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email  TEXT    NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        book_id     INTEGER REFERENCES books(book_id) ON DELETE SET NULL,
        event       TEXT    NOT NULL,
        source      TEXT,
        meta_json   TEXT,
        app_version TEXT,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_usage_events_user_email ON usage_events(user_email, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_events_book_id    ON usage_events(book_id);
      CREATE INDEX IF NOT EXISTS idx_usage_events_event      ON usage_events(event, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_events_created_at ON usage_events(created_at);
    `);
  },
};
