'use strict';
// Ideen duerfen am BUCH haengen, ohne Seite und ohne Kapitel (docs/ideen-board.md).
//
// Der Anker-CHECK wird von „genau eins" (XOR) zu „hoechstens eins": beide NULL
// heisst Buch-Idee — ein Einfall, der noch keinen Ort im Text hat und den der
// Autor spaeter selbst auf eine Seite oder ein Kapitel verschiebt. Beide gesetzt
// bleibt verboten; eine Idee hat nie zwei Anker.
//
// Kein Sentinel und keine `kind`-Spalte: der Anker ist schon durch die zwei
// nullbaren FKs vollstaendig beschrieben, ein Diskriminator daneben waere eine
// zweite Wahrheit ueber dieselbe Frage.
//
// Recreate, weil SQLite einen Tabellen-CHECK nicht per ALTER aendern kann.
module.exports = {
  version: 314,
  fkOff: true,
  up(db) {
    db.exec('DROP TABLE IF EXISTS ideen_new');
    db.exec(`
      CREATE TABLE ideen_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(book_id)       ON DELETE CASCADE,
        page_id     INTEGER          REFERENCES pages(page_id)       ON DELETE CASCADE,
        chapter_id  INTEGER          REFERENCES chapters(chapter_id) ON DELETE CASCADE,
        user_email  TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        status      TEXT    NOT NULL DEFAULT 'offen'
                      CHECK(status IN ('offen','in_arbeit','erledigt','verworfen')),
        status_at   TEXT,
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL,
        CHECK (page_id IS NULL OR chapter_id IS NULL),
        FOREIGN KEY (user_email) REFERENCES app_users(email) ON DELETE CASCADE
      )
    `);
    db.exec(`
      INSERT INTO ideen_new (id, book_id, page_id, chapter_id, user_email, content,
                             status, status_at, created_at, updated_at)
      SELECT id, book_id, page_id, chapter_id, user_email, content,
             status, status_at, created_at, updated_at
        FROM ideen
    `);
    db.exec('DROP TABLE ideen');
    db.exec('ALTER TABLE ideen_new RENAME TO ideen');
    db.exec('CREATE INDEX idx_ideen_page_user    ON ideen(page_id, user_email)');
    db.exec('CREATE INDEX idx_ideen_chapter_user ON ideen(chapter_id, user_email)');
    db.exec('CREATE INDEX idx_ideen_book_user    ON ideen(book_id, user_email)');
    db.exec('CREATE INDEX idx_ideen_user_email   ON ideen(user_email)');
  },
};
