'use strict';
// hubspot_page_links.locked_blocks: Push-Sperre wie bei WordPress
// (blog_page_links.locked_blocks). Kommagetrennte Liste der Elemente, die der
// HubSpot-Entwurf traegt, die App aber nicht uebernimmt (CTA, Formular, Embed,
// HubL-Modul, im Abschnitt fehlendes Bild). NULL = pushbar.
module.exports = {
  version: 371,
  up(db) {
    const cols = db.pragma('table_info(hubspot_page_links)').map(c => c.name);
    if (!cols.includes('locked_blocks')) db.exec('ALTER TABLE hubspot_page_links ADD COLUMN locked_blocks TEXT');
  },
};
