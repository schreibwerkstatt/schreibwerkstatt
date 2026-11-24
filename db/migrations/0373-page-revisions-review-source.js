'use strict';
// page_revisions.source-CHECK um 'review' erweitern: ein übernommener
// Änderungsvorschlag eines Reviewers (Share-Link, Review-Modus) erscheint in
// der Revisionsliste als «Review» (docs/share-link.md → „Änderungsvorschläge").
// Ohne den Wert scheitert der Revisions-Insert am CHECK — der Save selbst geht
// durch (Revisionsfehler brechen ihn bewusst nicht ab), die Revision fehlte
// still. SQLite kann einen CHECK nicht per ALTER ändern → Recreate; alle
// Spalten inkl. pinned/label wandern mit.

module.exports = {
  version: 373,
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
                        ('focus','main','book','chat-apply','lektorat-apply','import','conflict','macapp','split','restore','review')),
        user_email    TEXT REFERENCES app_users(email) ON DELETE SET NULL,
        summary       TEXT,
        created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        client        TEXT,
        pinned        INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
        label         TEXT
      );
      INSERT INTO page_revisions_new (id, page_id, book_id, body_html, chars, words, tok, source, user_email, summary, created_at, client, pinned, label)
        SELECT id, page_id, book_id, body_html, chars, words, tok, source, user_email, summary, created_at, client, pinned, label
          FROM page_revisions;
      DROP TABLE page_revisions;
      ALTER TABLE page_revisions_new RENAME TO page_revisions;
      CREATE INDEX idx_page_revisions_page ON page_revisions(page_id, created_at DESC);
      CREATE INDEX idx_page_revisions_book ON page_revisions(book_id, created_at DESC);
      CREATE INDEX idx_page_revisions_user ON page_revisions(user_email);
      CREATE INDEX idx_page_revisions_pinned ON page_revisions(page_id) WHERE pinned = 1;
    `);
  },
};
