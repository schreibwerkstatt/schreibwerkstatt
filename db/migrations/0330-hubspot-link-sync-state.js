'use strict';
// HubSpot-Links bekommen dasselbe Sync-Modell wie die WordPress-Links
// (docs/hubspot-sync.md → „Status-Modell"):
//   - hubspot_updated_at: zuletzt gesehener `updated`-Stempel des Draft-Buffers.
//     Die Push-Vorab-Pruefung vergleicht ihn mit dem aktuellen Draft — ist der
//     juenger, hat jemand in HubSpot geaendert, und der Push wird zum Konflikt,
//     statt die Aenderung stumm zu ueberschreiben.
//   - last_pulled_at: Sync-Punkt nach „HubSpot uebernehmen" in der
//     Konflikt-Aufloesung (wie blog_page_links.last_pulled_at).
//   - conflict_state: 'detected' bis der User im Diff entschieden hat.
// Backfill: last_pushed_at ist die Sync-Baseline des Badges; Links aus der Zeit,
// als nur hubspot_created_at gesetzt war, bekommen diesen Wert.
module.exports = {
  version: 330,
  up(db) {
    const cols = new Set(db.prepare('PRAGMA table_info(hubspot_page_links)').all().map(c => c.name));
    if (!cols.has('hubspot_updated_at')) {
      db.exec('ALTER TABLE hubspot_page_links ADD COLUMN hubspot_updated_at TEXT');
    }
    if (!cols.has('last_pulled_at')) {
      db.exec('ALTER TABLE hubspot_page_links ADD COLUMN last_pulled_at TEXT');
    }
    if (!cols.has('conflict_state')) {
      db.exec(`ALTER TABLE hubspot_page_links ADD COLUMN conflict_state TEXT
        CHECK(conflict_state IS NULL OR conflict_state IN ('detected','resolved-app','resolved-remote'))`);
    }
    db.exec('UPDATE hubspot_page_links SET last_pushed_at = hubspot_created_at WHERE last_pushed_at IS NULL');
  },
};
