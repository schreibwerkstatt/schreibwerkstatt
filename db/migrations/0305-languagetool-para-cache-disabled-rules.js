'use strict';
// LanguageTool: Absatz-Cache statt Seiten-Cache + abgeschaltete Regeln.
//
// `languagetool_para_cache` haelt die UNGEFILTERTEN LT-Treffer eines einzelnen
// Absatzes, geschluesselt ueber den Text-Hash. Ohne Seiten-Bezug: derselbe
// Absatz liefert dieselben Treffer, egal in welcher Seite oder welchem Editor
// er steht. Benutzerbezogenes (Woerterbuch, Figurennamen, abgeschaltete Regeln)
// wird erst beim Ausliefern gefiltert — darum darf der Cache zwischen
// Mitarbeitern eines Buchs geteilt werden.
//
// `page_languagetool_cache` faellt ersatzlos weg: reiner Cache, rekonstruierbar.
//
// `languagetool_disabled_rules`: LT-Regeln, die ein User abgeschaltet hat —
// `book_id` NULL = in allen Buechern, sonst nur in diesem Buch. `rule_label`
// ist die Regel-Beschreibung von LanguageTool fuer die Liste in den
// Einstellungen (externer Text, kein Snapshot einer eigenen Entitaet).
module.exports = {
  version: 305,
  up(db) {
    db.exec(`DROP TABLE IF EXISTS page_languagetool_cache`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS languagetool_para_cache (
        content_hash TEXT    NOT NULL,
        lang         TEXT    NOT NULL,
        picky        INTEGER NOT NULL DEFAULT 0,
        matches_json TEXT    NOT NULL,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (content_hash, lang, picky)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_lt_para_cache_created ON languagetool_para_cache(created_at)`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS languagetool_disabled_rules (
        user_email TEXT    NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        book_id    INTEGER REFERENCES books(book_id) ON DELETE CASCADE,
        rule_id    TEXT    NOT NULL,
        rule_label TEXT,
        created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lt_disabled_rules_global
               ON languagetool_disabled_rules(user_email, rule_id) WHERE book_id IS NULL`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_lt_disabled_rules_scoped
               ON languagetool_disabled_rules(user_email, book_id, rule_id) WHERE book_id IS NOT NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_lt_disabled_rules_user ON languagetool_disabled_rules(user_email)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_lt_disabled_rules_book ON languagetool_disabled_rules(book_id)`);
  },
};
