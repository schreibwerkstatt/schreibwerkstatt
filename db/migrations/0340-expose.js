'use strict';
// Exposé (Bucheinstellungen → Reiter Exposé, Job /jobs/expose).
//
// book_exposes: eine Zeile pro Lauf (Historie) — NUR was neu entsteht: Logline,
// Kurzinhalt/Synopse bzw. Kurzbeschreibung/Gliederung, Figurenliste als
// [{fig_id, text}] und der Klappentext-Vorschlag, jeweils als KI-Fassung
// (result_json) und Autorfassung (edited_json). Titel, Autor, Genre, Umfang,
// Zielgruppe, Vergleichstitel, Vita und der Klappentext selbst leben in
// book_settings / book_publication und werden nie hierher kopiert.
// `sig` = Signatur der Eingabe: gleicher Text + gleiche Angaben → derselbe Lauf,
// keine zweite Historienzeile.
//
// expose_synopsis_cache: interne Inhaltsangaben je Kapitel(-Teil) fuer den
// Multi-Pass. Schluessel ist die Signatur des gesendeten Prompts (traegt den
// Kapiteltext), darum keine Kapitel-FK und kein Sentinel fuer kapitellose
// Abschnitte; der Job raeumt nicht mehr benutzte Signaturen nach jedem Lauf ab.

module.exports = {
  version: 340,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS book_exposes (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id        INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email     TEXT    NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        profil         TEXT    NOT NULL CHECK(profil IN ('narrativ','sachlich')),
        basis          TEXT    NOT NULL CHECK(basis IN ('single','multi')),
        sig            TEXT    NOT NULL,
        result_json    TEXT    NOT NULL,
        edited_json    TEXT,
        warnungen_json TEXT,
        model          TEXT,
        created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_book_exposes_book_user ON book_exposes(book_id, user_email, created_at);
      CREATE INDEX IF NOT EXISTS idx_book_exposes_user ON book_exposes(user_email);

      CREATE TABLE IF NOT EXISTS expose_synopsis_cache (
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        provider    TEXT    NOT NULL,
        sig         TEXT    NOT NULL,
        inhalt_json TEXT    NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (book_id, user_email, provider, sig)
      );
      CREATE INDEX IF NOT EXISTS idx_expose_synopsis_cache_user ON expose_synopsis_cache(user_email);
    `);
  },
};
