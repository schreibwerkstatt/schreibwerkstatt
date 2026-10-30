'use strict';
// Einzelnes Nachprüfen eines Kontinuitäts-Befunds (docs/komplett.md, «Befund
// nachprüfen»): der Job `kontinuitaet-recheck` legt sein letztes Urteil am Issue ab.
//
// recheck_verdict: 'behoben' (mit wörtlich gefundenem Beleg → Issue resolved),
//   'teilweise', 'weiterhin', 'unbelegt' (Modell meldete behoben, der Beleg steht
//   aber nicht im aktuellen Text — bleibt offen). NULL = nie nachgeprüft.
// recheck_reason / recheck_beleg: Begründung und Beleg-Zitat des Modells.
// recheck_at: Zeitpunkt des Urteils (ISO+Z).
module.exports = {
  version: 344,
  up(db) {
    const cols = new Set(db.prepare('PRAGMA table_info(continuity_issues)').all().map(c => c.name));
    if (!cols.has('recheck_verdict')) {
      db.exec(`ALTER TABLE continuity_issues ADD COLUMN recheck_verdict TEXT
        CHECK(recheck_verdict IS NULL OR recheck_verdict IN ('behoben','teilweise','weiterhin','unbelegt'))`);
    }
    if (!cols.has('recheck_reason')) db.exec('ALTER TABLE continuity_issues ADD COLUMN recheck_reason TEXT');
    if (!cols.has('recheck_beleg')) db.exec('ALTER TABLE continuity_issues ADD COLUMN recheck_beleg TEXT');
    if (!cols.has('recheck_at')) db.exec('ALTER TABLE continuity_issues ADD COLUMN recheck_at TEXT');
  },
};
