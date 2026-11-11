'use strict';
// Welt-Fakten: Entscheide des Autors, die den Full-Replace der Komplettanalyse
// überdauern (docs/komplett.md «Welt-Fakten: wer den Index liest»).
//
// world_fact_suppressions — Analyse-Aussagen, die der Autor gelöscht oder durch einen
//   gepflegten Fakt ersetzt hat. Die Analyse formuliert dieselbe Aussage bei jedem Lauf
//   etwas anders; saveFaktenToDb gleicht darum über den Aussage-Schlüssel UND über
//   Embedding-Ähnlichkeit ab (routes/jobs/komplett/world-facts-match.js). Ein Treffer
//   legt keine Zeile an; mit `replaced_by` wandern seine Kapitel an den gepflegten Fakt.
//   SET NULL: wird der gepflegte Fakt gelöscht, bleibt die Aussage unterdrückt — der
//   Autor hat sie zweimal verworfen.
//
// world_fact_chapters.manual — vom Autor gesetzter Kapitel-Bezug. Die Analyse baut die
//   übrigen Brücken bei jedem Lauf neu; manuelle bleiben stehen.
//
// user_email ohne FK wie world_facts selbst (USER_REF_PLAN mode 'sweep').
module.exports = {
  version: 363,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS world_fact_suppressions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT,
        fact_key    TEXT NOT NULL,
        subjekt     TEXT,
        fakt        TEXT NOT NULL,
        replaced_by INTEGER REFERENCES world_facts(id) ON DELETE SET NULL,
        created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wfsup_key ON world_fact_suppressions(book_id, IFNULL(user_email, ''), fact_key);
      CREATE INDEX IF NOT EXISTS idx_wfsup_replaced ON world_fact_suppressions(replaced_by);
    `);
    const cols = new Set(db.prepare('PRAGMA table_info(world_fact_chapters)').all().map(c => c.name));
    if (!cols.has('manual')) {
      db.exec('ALTER TABLE world_fact_chapters ADD COLUMN manual INTEGER NOT NULL DEFAULT 0 CHECK(manual IN (0, 1))');
    }
  },
};
