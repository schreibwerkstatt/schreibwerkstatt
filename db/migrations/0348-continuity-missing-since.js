'use strict';
// Kontinuität: offene Befunde, die ein späterer Lauf nicht mehr meldet, wandern in den
// neuen Lauf mit (db/continuity.js#saveContinuityCheck), statt mit dem alten Check
// unsichtbar zu werden. `missing_since` = Zeitpunkt (ISO+Z) des ersten Laufs, der den
// Befund nicht mehr gemeldet hat; NULL = der Lauf hat ihn selbst gemeldet.
module.exports = {
  version: 348,
  up(db) {
    const cols = new Set(db.prepare('PRAGMA table_info(continuity_issues)').all().map(c => c.name));
    if (!cols.has('missing_since')) db.exec('ALTER TABLE continuity_issues ADD COLUMN missing_since TEXT');
  },
};
