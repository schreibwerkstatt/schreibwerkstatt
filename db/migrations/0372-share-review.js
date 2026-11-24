'use strict';
// Review ueber den Share-Link (docs/share-link.md → „Review-Modus"):
//   - share_links.mode: 'leser' (Beta-Leser, Sterne-Fazit, App-Hinweis) oder
//     'review' (benannte Reviewer, Aenderungsvorschlaege, «Review abschliessen»)
//   - share_comments.suggestion_*: ein verankerter Kommentar kann einen
//     Ersatztext fuer die markierte Stelle tragen; der Owner uebernimmt oder
//     lehnt ab (`suggestion_state`). NULL = gewoehnlicher Kommentar.
//   - share_link_reviewers: die Reviewer eines Review-Links (Name, vom Browser
//     beanspruchtes reader_token, abgeschlossen am + Schlussnotiz). Kein Konto
//     — Kollegen kommen ueber den Link, wie jeder Leser.
module.exports = {
  version: 372,
  up(db) {
    const linkCols = db.pragma('table_info(share_links)').map(c => c.name);
    if (!linkCols.includes('mode')) {
      db.exec("ALTER TABLE share_links ADD COLUMN mode TEXT NOT NULL DEFAULT 'leser' CHECK(mode IN ('leser','review'))");
    }
    const cCols = db.pragma('table_info(share_comments)').map(c => c.name);
    if (!cCols.includes('suggestion_text')) db.exec('ALTER TABLE share_comments ADD COLUMN suggestion_text TEXT');
    if (!cCols.includes('suggestion_state')) {
      db.exec("ALTER TABLE share_comments ADD COLUMN suggestion_state TEXT CHECK(suggestion_state IS NULL OR suggestion_state IN ('open','accepted','rejected'))");
    }
    if (!cCols.includes('suggestion_decided_at')) db.exec('ALTER TABLE share_comments ADD COLUMN suggestion_decided_at TEXT');

    db.exec(`
      CREATE TABLE IF NOT EXISTS share_link_reviewers (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        share_token  TEXT    NOT NULL REFERENCES share_links(token) ON DELETE CASCADE,
        name         TEXT    NOT NULL,
        position     INTEGER NOT NULL DEFAULT 0,
        reader_token TEXT,
        done_at      TEXT,
        done_note    TEXT,
        created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(share_token, name COLLATE NOCASE)
      );
      CREATE INDEX IF NOT EXISTS idx_share_link_reviewers_token ON share_link_reviewers(share_token);
    `);
  },
};
