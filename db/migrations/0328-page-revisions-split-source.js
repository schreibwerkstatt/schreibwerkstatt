'use strict';
// page_revisions.source-CHECK um 'split' erweitern: «Abschnitt teilen»
// (Content-Store splitPage) markiert Kopf- und Schwanz-Revision mit eigener
// Quelle, damit die Revisionsliste das Teilen als Aktion zeigt. SQLite kann
// einen CHECK nicht per ALTER aendern → Recreate.

module.exports = {
  version: 328,
  fkOff: true,
  up(db) {
    db.exec(`
      DROP TABLE IF EXISTS page_revisions_new;
      CREATE TABLE page_revisions_new (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        page_id       INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        book_id       INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        body_html     TEXT NOT NULL,
        chars         INTEGER,
        words         INTEGER,
        tok           INTEGER,
        source        TEXT NOT NULL CHECK(source IN
                        ('focus','main','book','chat-apply','lektorat-apply','import','conflict','macapp','split')),
        user_email    TEXT REFERENCES app_users(email) ON DELETE SET NULL,
        summary       TEXT,
        created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        client        TEXT
      );
      INSERT INTO page_revisions_new (id, page_id, book_id, body_html, chars, words, tok, source, user_email, summary, created_at, client)
        SELECT id, page_id, book_id, body_html, chars, words, tok, source, user_email, summary, created_at, client
          FROM page_revisions;
      DROP TABLE page_revisions;
      ALTER TABLE page_revisions_new RENAME TO page_revisions;
      CREATE INDEX idx_page_revisions_page ON page_revisions(page_id, created_at DESC);
      CREATE INDEX idx_page_revisions_book ON page_revisions(book_id, created_at DESC);
      CREATE INDEX idx_page_revisions_user ON page_revisions(user_email);
    `);
  },
};
