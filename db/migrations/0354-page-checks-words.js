'use strict';
// Wortzahl des geprüften Stands an jedem Lektorat-Lauf. Die Fehlerdichte der
// Fehler-Heatmap und des Fehlerdichte-Trends rechnet Befunde pro 1000 geprüfte
// Wörter; die Befunde gehören zum Text, den der Lauf gesehen hat, nicht zum
// heutigen Umfang. Ohne die Spalte verschob jedes spätere Kürzen oder Erweitern
// eines Abschnitts die Dichte, ohne dass sich an den Befunden etwas änderte.
//
// Kein Backfill: den Text alter Läufe gibt es nicht mehr. NULL heisst «vor
// dieser Spalte» und fällt beim Lesen auf den aktuellen Umfang zurück
// (lib/lektorat-metrics.js#checkedWords).
module.exports = {
  version: 354,
  up(db) {
    const cols = db.prepare('PRAGMA table_info(page_checks)').all().map(c => c.name);
    if (!cols.includes('words')) db.exec('ALTER TABLE page_checks ADD COLUMN words INTEGER');
  },
};
