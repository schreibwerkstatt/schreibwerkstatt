'use strict';
// share_links.show_promo: dezenter Hinweis auf die App in der Share-Leseansicht
// (Footer + einmaliger Hinweis nach dem ersten Kommentar). Pro Link abschaltbar,
// Standard an (1). 0|1.
module.exports = {
  version: 370,
  up(db) {
    const cols = db.pragma('table_info(share_links)').map(c => c.name);
    if (!cols.includes('show_promo')) db.exec('ALTER TABLE share_links ADD COLUMN show_promo INTEGER NOT NULL DEFAULT 1');
  },
};
