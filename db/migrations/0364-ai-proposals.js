'use strict';
// Offene KI-Vorschläge, die der Autor noch nicht übernommen oder verworfen hat
// (docs/autorenprofil.md; Schreib-/Lesepfad: db/ai-proposals.js).
//
// Autorenprofil-Deutung und Buch-Stilprofil speichern ihr Ergebnis bewusst NICHT
// als geltenden Text: es ist ein Vorschlag, über den erst «Übernehmen» entscheidet.
// Bis dahin lebte es nur im Job-Ergebnis im Speicher — wer die App während des
// Laufs schloss, verlor es nach der Job-Aufräumfrist oder einem Neustart. Diese
// Tabelle hält den Vorschlag, bis der Autor entscheidet.
//
// Je (kind, user_email, book_id) höchstens einer: ein neuer Lauf ersetzt den
// offenen Vorschlag. `book_id` NULL = kontobezogen (Autorenprofil).
// CASCADE auf beiden Kanten: ein Vorschlag ohne Konto oder ohne Buch hat
// niemanden mehr, der ihn übernehmen könnte.
module.exports = {
  version: 364,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_proposals (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        kind         TEXT    NOT NULL CHECK(kind IN ('autorenprofil', 'stilprofil')),
        user_email   TEXT    NOT NULL REFERENCES app_users(email) ON DELETE CASCADE,
        book_id      INTEGER REFERENCES books(book_id) ON DELETE CASCADE,
        payload_json TEXT    NOT NULL,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        CHECK ((kind = 'autorenprofil' AND book_id IS NULL) OR (kind = 'stilprofil' AND book_id IS NOT NULL))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_proposals_scope ON ai_proposals(kind, user_email, IFNULL(book_id, 0));
      CREATE INDEX IF NOT EXISTS idx_ai_proposals_user ON ai_proposals(user_email);
      CREATE INDEX IF NOT EXISTS idx_ai_proposals_book ON ai_proposals(book_id);
    `);
  },
};
