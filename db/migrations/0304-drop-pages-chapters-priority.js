'use strict';
// pages.priority / chapters.priority entfernen. Die Reihenfolge trägt allein
// `position`; `priority` lief nur noch als Duplikat mit und wurde beim Lesen
// als Fallback gezogen. Rows ohne `position` übernehmen vorher den Wert aus
// `priority`, damit ihre Sortierung erhalten bleibt.
module.exports = {
  version: 304,
  up(db) {
    db.exec(`UPDATE chapters SET position = priority WHERE position IS NULL AND priority IS NOT NULL`);
    db.exec(`UPDATE pages    SET position = priority WHERE position IS NULL AND priority IS NOT NULL`);
    db.exec(`ALTER TABLE chapters DROP COLUMN priority`);
    db.exec(`ALTER TABLE pages    DROP COLUMN priority`);
  },
};
