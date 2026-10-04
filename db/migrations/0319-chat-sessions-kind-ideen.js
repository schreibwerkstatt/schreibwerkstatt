'use strict';
// chat_sessions.kind bekommt den fuenften Wert 'ideen' fuer den Ideen-Chat (Panel im
// Ideen-Board, buchweit wie kind='book'/'research'/'plot', also page_id IS NULL).
// SQLite kann den CHECK nicht per ALTER aendern → Recreate. Spalten und Indexe 1:1
// wie bisher, nur Wertemenge + Kombinations-CHECK erweitert.

module.exports = {
  version: 319,
  fkOff: true,
  up(db) {
    db.exec(`
      DROP TABLE IF EXISTS chat_sessions_new;
      CREATE TABLE chat_sessions_new (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id           INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        kind              TEXT    NOT NULL DEFAULT 'page' CHECK(kind IN ('page','book','research','plot','ideen')),
        page_id           INTEGER REFERENCES pages(page_id) ON DELETE CASCADE,
        user_email        TEXT    NOT NULL,
        created_at        TEXT    NOT NULL,
        last_message_at   TEXT    NOT NULL,
        opening_page_text TEXT,
        title             TEXT,
        CHECK ((kind = 'page' AND page_id IS NOT NULL)
            OR (kind IN ('book','research','plot','ideen') AND page_id IS NULL))
      );
      INSERT INTO chat_sessions_new
        (id, book_id, kind, page_id, user_email, created_at, last_message_at, opening_page_text, title)
      SELECT id, book_id, kind, page_id, user_email, created_at, last_message_at, opening_page_text, title
      FROM chat_sessions;
      DROP TABLE chat_sessions;
      ALTER TABLE chat_sessions_new RENAME TO chat_sessions;
      CREATE INDEX idx_cs_page_id ON chat_sessions(page_id, user_email);
      CREATE INDEX idx_cs_book_id ON chat_sessions(book_id, user_email);
      CREATE INDEX idx_cs_kind    ON chat_sessions(book_id, user_email, kind);
    `);
  },
};
