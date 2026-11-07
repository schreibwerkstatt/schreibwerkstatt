'use strict';
// Automatischer Erledigt-Check der Ideen (docs/ideen-board.md, «Erledigt-Check
// nach dem Speichern»).
//
// Nach einer grösseren Änderung an einem Abschnitt prüft ein KI-Job die offenen
// Pendenzen, die an diesem Abschnitt hängen, gegen den neuen Text. Was er für
// eingelöst hält (mit geprüftem Zitat), legt er als Hinweis ab; der User hakt
// in der Ideen-Karte bzw. im Board selbst ab oder verwirft den Hinweis.
//
//   idee_check_hints     — ein Hinweis je Idee (PK idee_id), CASCADE an der
//                          Idee und am Abschnitt des Belegs: fällt einer davon,
//                          ist der Hinweis gegenstandslos.
//   idee_check_baselines — Textstand je (Abschnitt, User) beim letzten Check;
//                          daran misst der Auslöser, ob die Änderung «gross»
//                          genug für einen neuen Lauf ist.
//   app_users.ideen_auto_check — persönlicher Schalter (1 = an, Default).
module.exports = {
  version: 359,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS idee_check_hints (
        idee_id     INTEGER PRIMARY KEY REFERENCES ideen(id) ON DELETE CASCADE,
        page_id     INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        beleg       TEXT NOT NULL,
        begruendung TEXT,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_idee_check_hints_page ON idee_check_hints(page_id);

      CREATE TABLE IF NOT EXISTS idee_check_baselines (
        page_id    INTEGER NOT NULL REFERENCES pages(page_id) ON DELETE CASCADE,
        user_email TEXT NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        text       TEXT NOT NULL,
        checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (page_id, user_email)
      );
      CREATE INDEX IF NOT EXISTS idx_idee_check_baselines_user ON idee_check_baselines(user_email);
    `);
    const cols = db.pragma('table_info(app_users)').map(c => c.name);
    if (!cols.includes('ideen_auto_check')) {
      db.exec('ALTER TABLE app_users ADD COLUMN ideen_auto_check INTEGER NOT NULL DEFAULT 1 CHECK(ideen_auto_check IN (0,1))');
    }
  },
};
