'use strict';
// Redundanz-Radar (docs/redundanz.md):
//
// `redundancy_runs`: letztes Ergebnis pro (Buch, User), damit die Karte beim
// Öffnen nicht leer steht. Reine Ableitung → CASCADE mit Buch und Konto. Das
// JSON trägt IDs und Passagentext, keine Seiten-/Figurennamen (die löst das
// Frontend zur Lesezeit auf).
//
// `redundancy_dismissals`: Paare, die der User als gewollte Wiederholung
// ignoriert; der Scan filtert sie heraus. `kind` + XOR-Anker statt
// polymorpher ID: Seitenpaar (page_a/b) ODER Figurenpaar (figure_a/b), immer
// normiert mit a < b. CASCADE auf alle Anker — ohne beide Stellen ist die
// Zeile bedeutungslos. Eindeutigkeit über partielle Indexe, weil NULLs in einem
// gemeinsamen UNIQUE als verschieden gälten.
module.exports = {
  version: 310,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS redundancy_runs (
        book_id     INTEGER NOT NULL REFERENCES books(book_id)    ON DELETE CASCADE,
        user_email  TEXT    NOT NULL REFERENCES app_users(email)  ON DELETE CASCADE,
        threshold   REAL    NOT NULL,
        result_json TEXT    NOT NULL,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (book_id, user_email)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_redundancy_runs_user ON redundancy_runs(user_email)');

    db.exec(`
      CREATE TABLE IF NOT EXISTS redundancy_dismissals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(book_id)   ON DELETE CASCADE,
        user_email  TEXT    NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        kind        TEXT    NOT NULL CHECK(kind IN ('page','figure')),
        page_a_id   INTEGER REFERENCES pages(page_id) ON DELETE CASCADE,
        page_b_id   INTEGER REFERENCES pages(page_id) ON DELETE CASCADE,
        figure_a_id INTEGER REFERENCES figures(id)    ON DELETE CASCADE,
        figure_b_id INTEGER REFERENCES figures(id)    ON DELETE CASCADE,
        created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK (
          (kind = 'page'
            AND page_a_id IS NOT NULL AND page_b_id IS NOT NULL AND page_a_id < page_b_id
            AND figure_a_id IS NULL AND figure_b_id IS NULL)
          OR
          (kind = 'figure'
            AND figure_a_id IS NOT NULL AND figure_b_id IS NOT NULL AND figure_a_id < figure_b_id
            AND page_a_id IS NULL AND page_b_id IS NULL)
        )
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_redundancy_dis_page
               ON redundancy_dismissals(book_id, user_email, page_a_id, page_b_id) WHERE kind = 'page'`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_redundancy_dis_figure
               ON redundancy_dismissals(book_id, user_email, figure_a_id, figure_b_id) WHERE kind = 'figure'`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_redundancy_dis_book_user ON redundancy_dismissals(book_id, user_email)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_redundancy_dis_user ON redundancy_dismissals(user_email)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_redundancy_dis_page_a ON redundancy_dismissals(page_a_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_redundancy_dis_page_b ON redundancy_dismissals(page_b_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_redundancy_dis_figure_a ON redundancy_dismissals(figure_a_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_redundancy_dis_figure_b ON redundancy_dismissals(figure_b_id)');
  },
};
