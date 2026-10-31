'use strict';
// Ereignisse bearbeiten (docs/komplett.md, «Autorenpflege schlägt Analyse»).
//
// zeitstrahl_events.ki_key: Vergleichsschlüssel (cards/ereignisse/model.js#
//   eventGroupKey) des KI-Stands, gesichert beim ersten Bearbeiten durch den
//   Autor. Die nächste Komplettanalyse liefert dasselbe Ereignis wieder in der
//   KI-Fassung; ohne diesen Schlüssel stünde es dann als zweite Zeile neben der
//   gepflegten. NULL = nie bearbeitet (Muster figures.ki_name).
module.exports = {
  version: 347,
  up(db) {
    const cols = new Set(db.prepare('PRAGMA table_info(zeitstrahl_events)').all().map(c => c.name));
    if (!cols.has('ki_key')) db.exec('ALTER TABLE zeitstrahl_events ADD COLUMN ki_key TEXT');
  },
};
