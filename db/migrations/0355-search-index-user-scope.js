'use strict';
// Volltext-Index neu aufbauen (lib/search.js):
//
// - `user_email UNINDEXED` in beiden Tabellen: Figuren, Schauplätze, Szenen,
//   Songs und Ideen sind Daten PRO USER. Ohne die Spalte zeigte die Volltext-
//   suche einem Co-Autor die Analyse-Daten und privaten Ideen der anderen.
// - Tokenizer ohne `-` in tokenchars: «Hans» findet «Hans-Peter»; die Suche nach
//   «Hans-Peter» läuft als Phrase über beide Teile.
// - Trigram mit `remove_diacritics 1`: der Titel-Fallback findet «Muller» in
//   «Müller» wie der Haupt-Index.
// - Spalte `lang` entfällt (wurde nie befüllt).
//
// Die rowid ist ab jetzt aus (kind, entity_id) abgeleitet (lib/search.js#_rowid),
// damit Upsert/Remove per rowid statt per Vollscan über UNINDEXED-Spalten
// löschen. Der Index ist abgeleitet: Tabellen droppen, neu anlegen, Reindex beim
// nächsten Boot (search_meta.reindex_required → server.js#reindexIfNeeded).
module.exports = {
  version: 355,
  up(db) {
    db.exec('DROP TABLE IF EXISTS search_index');
    db.exec('DROP TABLE IF EXISTS search_trigram');
    db.exec(`
      CREATE VIRTUAL TABLE search_index USING fts5(
        kind UNINDEXED,
        entity_id UNINDEXED,
        book_id UNINDEXED,
        user_email UNINDEXED,
        title,
        body,
        tokenize="unicode61 remove_diacritics 2 tokenchars '_'"
      )
    `);
    db.exec(`
      CREATE VIRTUAL TABLE search_trigram USING fts5(
        kind UNINDEXED,
        entity_id UNINDEXED,
        book_id UNINDEXED,
        user_email UNINDEXED,
        title,
        tokenize="trigram remove_diacritics 1"
      )
    `);
    db.prepare(`
      INSERT INTO search_meta (key, value, updated_at)
      VALUES ('reindex_required', '1', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run();
  },
};
