'use strict';
// blog_page_links.locked_blocks: welche WordPress-Elemente ein Beitrag enthaelt,
// die der Import nicht uebernimmt (lib/wp-html.js#wpLossyBlocks, kommagetrennt;
// NULL = round-trip-sicher). Solche Beitraege sperrt der Push, weil er sie im
// Live-Blog loeschte. Gemerkt, damit das Badge im Buchorganizer die Sperre zeigt,
// BEVOR jemand den Abschnitt in der App bearbeitet — nicht erst beim Push.
// Gesetzt von Import, Pull, Push-Vorab-Pruefung und Abgleich.
module.exports = {
  version: 333,
  up(db) {
    const cols = new Set(db.prepare('PRAGMA table_info(blog_page_links)').all().map(c => c.name));
    if (!cols.has('locked_blocks')) {
      db.exec('ALTER TABLE blog_page_links ADD COLUMN locked_blocks TEXT');
    }
  },
};
