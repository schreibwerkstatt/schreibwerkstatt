'use strict';
// Suche im Chat-Verlauf (Abschnitts-Chat + Buch-Chat, docs/chats.md#suche-im-verlauf).
//
// chat_messages_fts: FTS5 über chat_messages.content als External-Content-Tabelle
// (kein zweiter Textbestand). Gepflegt ausschliesslich über die Trigger unten —
// sie greifen auf JEDEM Schreibweg, auch bei der FK-CASCADE einer gelöschten
// Session/eines gelöschten Buchs und beim .swbook-Import. Darum fasst kein Job
// und keine Route den Index selbst an. `rebuild` holt den Bestand nach.
//
// chat_semantic_chunks: Embedding-Vektoren je Gesprächs-RUNDE (User-Frage +
// Antwort), verankert an der Antwort (`message_id`, CASCADE). Reiner
// Ableitungs-Index wie source_semantic_chunks — eigene Tabelle statt einer
// weiteren `kind` in semantic_chunks, weil Chats PRO USER sind und kein
// Buchinhalt: im Buch-Index liefen sie in jede Buch-Suche, jeden RAG-Kontext und
// die Buchlandkarte mit. Geschrieben vom Job `chat-embed-index`.
module.exports = {
  version: 324,
  up(db) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
        content,
        content='chat_messages',
        content_rowid='id',
        tokenize="unicode61 remove_diacritics 2 tokenchars '-_'"
      );

      CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ai AFTER INSERT ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chat_messages_fts_ad AFTER DELETE ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS chat_messages_fts_au AFTER UPDATE OF content ON chat_messages BEGIN
        INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO chat_messages_fts(rowid, content) VALUES (new.id, new.content);
      END;

      INSERT INTO chat_messages_fts(chat_messages_fts) VALUES ('rebuild');

      CREATE TABLE IF NOT EXISTS chat_semantic_chunks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id   INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
        chunk_ix     INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT    NOT NULL,
        model        TEXT    NOT NULL,
        dim          INTEGER NOT NULL,
        vector       BLOB    NOT NULL,
        text         TEXT    NOT NULL,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (message_id, chunk_ix, model)
      );
      CREATE INDEX IF NOT EXISTS idx_cschunk_model ON chat_semantic_chunks(model);
    `);
  },
};
