'use strict';
// Kontinuitäts-Befunde: Triage „kein Fehler" und Seiten-Anker der beiden Stellen.
//
// dismissed/dismissed_at: der Autor stuft einen Befund als Fehlalarm ein. Anders als
// `resolved` (Fehler behoben) bleibt er dann auch in späteren Läufen ausgeblendet —
// das Speichern übernimmt den Status per Wiedererkennung (lib/continuity-carryover.js).
//
// page_a_id/page_b_id: Seite, auf der stelle_a bzw. stelle_b steht, beim Speichern aus
// dem Buchtext ermittelt (lib/continuity-evidence.js). SET NULL: der Befund bleibt
// lesbar, wenn die Seite gelöscht wird; er verliert nur das Sprungziel.
module.exports = {
  version: 309,
  up(db) {
    const cols = new Set(db.prepare('PRAGMA table_info(continuity_issues)').all().map(c => c.name));
    if (!cols.has('dismissed')) db.exec('ALTER TABLE continuity_issues ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0');
    if (!cols.has('dismissed_at')) db.exec('ALTER TABLE continuity_issues ADD COLUMN dismissed_at TEXT');
    if (!cols.has('page_a_id')) db.exec('ALTER TABLE continuity_issues ADD COLUMN page_a_id INTEGER REFERENCES pages(page_id) ON DELETE SET NULL');
    if (!cols.has('page_b_id')) db.exec('ALTER TABLE continuity_issues ADD COLUMN page_b_id INTEGER REFERENCES pages(page_id) ON DELETE SET NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ci_page_a ON continuity_issues(page_a_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ci_page_b ON continuity_issues(page_b_id)');
  },
};
