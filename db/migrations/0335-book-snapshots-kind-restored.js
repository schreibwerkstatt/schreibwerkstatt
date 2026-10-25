'use strict';
// book_snapshots: Art der Fassung, Restore-Zeitpunkt, vorberechnete Extras-Uebersicht.
// `kind` unterscheidet die vom User gespeicherte Fassung von den beiden
// automatischen ('auto_backup' vor einem Restore, 'auto_finish' beim
// Fertig-Markieren) — der Drift-Check und die Dedup-Pruefung brauchen das als
// Spalte statt als Label-Vergleich. Backfill aus den bisher persistierten
// __i18n:-Label-Markern.
// `restored_at` = letzter Zeitpunkt, zu dem das Buch auf diese Fassung
// zurueckgesetzt wurde: die Drift-Baseline ist die Fassung, deren Stand das
// Buch zuletzt hatte (juengstes von created_at/restored_at), nicht die
// Auto-Sicherung, die der Restore angelegt hat.
// `extras_summary` = Zaehl-Uebersicht aus extras_json, beim Capture berechnet,
// damit der Reader den MB-grossen Blob nicht bei jedem Oeffnen parst. Alte
// Zeilen fuellt GET /snapshots/:bookId/:id beim ersten Lesen nach.

module.exports = {
  version: 335,
  up(db) {
    db.exec(`
      ALTER TABLE book_snapshots ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual'
        CHECK(kind IN ('manual','auto_backup','auto_finish'));
      ALTER TABLE book_snapshots ADD COLUMN restored_at TEXT;
      ALTER TABLE book_snapshots ADD COLUMN extras_summary TEXT;
      UPDATE book_snapshots SET kind = 'auto_backup' WHERE label = '__i18n:snapshots.autoBackupLabel__';
      UPDATE book_snapshots SET kind = 'auto_finish' WHERE label = '__i18n:snapshots.autoFinishLabel__';
    `);
  },
};
