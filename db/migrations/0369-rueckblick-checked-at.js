'use strict';
// tagebuch_rueckblicke.checked_at: wann ein Lauf den jüngsten Rückblick eines
// Zeitraums zuletzt als inhaltlich unverändert bestätigt hat (Cache-Treffer oder
// wortgleiches Ergebnis — dann entsteht keine neue History-Zeile). Die
// Aktualitäts-Berechnung der Coverage vergleicht Eintragsänderungen gegen
// max(created_at, checked_at); ohne die Spalte bliebe ein Rückblick nach einem
// Speichern ohne Textänderung für immer «veraltet». NULL = nie bestätigt.
module.exports = {
  version: 369,
  up(db) {
    const cols = db.pragma('table_info(tagebuch_rueckblicke)').map(c => c.name);
    if (!cols.includes('checked_at')) db.exec('ALTER TABLE tagebuch_rueckblicke ADD COLUMN checked_at TEXT');
  },
};
