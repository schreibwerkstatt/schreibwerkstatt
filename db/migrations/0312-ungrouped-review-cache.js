'use strict';
// Delta-Cache der Buchbewertungs-Kapitelanalyse für Seiten ohne Kapitel
// (pages.chapter_id IS NULL). Pendant zu chapter_review_cache, das per FK an
// chapters hängt und darum keinen Platz für diese Gruppe hat — eine eigene
// Tabelle statt eines Sentinel-Kapitels.
//
// phase: '' (ganze Gruppe) oder 'subN' (Teil-Abschnitt, wenn die Gruppe das
// Chunk-Budget sprengt). Reiner Cache → ON DELETE CASCADE auf Buch und Konto.
module.exports = {
  version: 312,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ungrouped_review_cache (
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        phase       TEXT    NOT NULL DEFAULT '',
        provider    TEXT    NOT NULL DEFAULT '',
        pages_sig   TEXT    NOT NULL,
        review_json TEXT    NOT NULL,
        cached_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (book_id, user_email, phase, provider)
      );
      CREATE INDEX IF NOT EXISTS idx_ungrouped_review_cache_user_email
        ON ungrouped_review_cache(user_email);
    `);
  },
};
