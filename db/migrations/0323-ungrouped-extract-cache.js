'use strict';
// Delta-Cache der Komplettanalyse-Extraktion für Seiten ohne Kapitel
// (pages.chapter_id IS NULL, Gruppen-Key '__ungrouped__'). Pendant zu
// chapter_extract_cache, das per FK an chapters hängt und für diese Gruppe keinen
// Platz hat — ohne eigene Tabelle wurde ein Vorwort im Multi-Pass bei JEDEM Lauf neu
// extrahiert, und der nicht-deterministische Output verschob jedes Mal die
// Konsolidierungs-Signatur. Muster: ungrouped_review_cache (Migration 312).
//
// phase: '' (ganze Gruppe), 'subN' (Teil, wenn die Gruppe das Chunk-Budget sprengt),
// jeweils optional mit ':gap' / ':figuren' / ':orte'. Reiner Cache → CASCADE.
module.exports = {
  version: 323,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ungrouped_extract_cache (
        book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email   TEXT    NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        phase        TEXT    NOT NULL DEFAULT '',
        provider     TEXT    NOT NULL DEFAULT '',
        pages_sig    TEXT    NOT NULL,
        extract_json TEXT    NOT NULL,
        cached_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (book_id, user_email, phase, provider)
      );
      CREATE INDEX IF NOT EXISTS idx_ungrouped_extract_cache_user_email
        ON ungrouped_extract_cache(user_email);
    `);
  },
};
