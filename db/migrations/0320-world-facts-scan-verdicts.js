'use strict';
// Welt-Fakten: zwei Tabellen neben dem Full-Replace-Index `world_facts`.
//
// world_facts_scan — „der Fakten-Index dieses Buchs ist erhoben worden". Ein leerer
// Index heisst sonst „nie analysiert"; `job_runs` taugt als Signal nicht, weil der
// Cache-Cleanup sie nach 30 Tagen löscht. Eine Zeile je (Buch, User), gesetzt von
// saveFaktenToDb.
//
// world_fact_verdicts — Urteile des Weltfakten-Faktenchecks, gekoppelt an den
// normalisierten Aussage-Schlüssel (`subjekt: fakt`) statt an world_facts.id: die ID
// ändert sich bei jedem Full-Replace, die Aussage meist nicht. So prüft ein zweiter
// Lauf die noch ungeprüften Fakten statt dieselben 20, und widerlegte Fakten bleiben
// über eine neue Extraktion hinweg als solche erkennbar.
//
// user_email ohne FK wie world_facts selbst (USER_REF_PLAN mode 'sweep').

const { factKeyOf } = require('../../lib/world-fact-key');

module.exports = {
  version: 320,
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS world_facts_scan (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id     INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email  TEXT,
        scanned_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wfs_book_user ON world_facts_scan(book_id, IFNULL(user_email, ''));

      CREATE TABLE IF NOT EXISTS world_fact_verdicts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        book_id      INTEGER NOT NULL REFERENCES books(book_id) ON DELETE CASCADE,
        user_email   TEXT,
        fact_key     TEXT NOT NULL,
        urteil       TEXT NOT NULL CHECK(urteil IN ('korrekt','falsch','unklar')),
        schwere      TEXT,
        beschreibung TEXT,
        empfehlung   TEXT,
        quelle       TEXT,
        checked_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wfv_key ON world_fact_verdicts(book_id, IFNULL(user_email, ''), fact_key);
    `);

    // Bestand: Bücher mit Fakten oder einem (noch nicht geprunten) abgeschlossenen Lauf
    // gelten als erhoben.
    db.exec(`
      INSERT OR IGNORE INTO world_facts_scan (book_id, user_email, scanned_at)
      SELECT book_id, user_email, MAX(updated_at) FROM world_facts GROUP BY book_id, user_email;
      INSERT OR IGNORE INTO world_facts_scan (book_id, user_email, scanned_at)
      SELECT jr.book_id, jr.user_email, MAX(COALESCE(jr.ended_at, jr.queued_at))
        FROM job_runs jr
       WHERE jr.type = 'komplett-analyse' AND jr.status = 'done'
         AND jr.book_id IN (SELECT book_id FROM books)
       GROUP BY jr.book_id, jr.user_email;
    `);

    // Bestehende Faktenfehler-Befunde als «falsch»-Urteile übernehmen — sonst wären
    // bereits widerlegte Fakten bis zum nächsten Faktencheck nicht mehr markiert.
    // Je Aussage gilt die jüngste Befund-Zeile.
    const rows = db.prepare(`
      SELECT ci.book_id, ci.user_email, ci.stelle_a, ci.schwere, ci.beschreibung, ci.empfehlung, ci.quelle,
             COALESCE(ci.updated_at, cc.checked_at) AS at
        FROM continuity_issues ci JOIN continuity_checks cc ON cc.id = ci.check_id
       WHERE ci.typ = 'faktenfehler' AND ci.quelle LIKE 'http%'
       ORDER BY cc.id, ci.id`).all();
    const ins = db.prepare(`
      INSERT INTO world_fact_verdicts (book_id, user_email, fact_key, urteil, schwere, beschreibung, empfehlung, quelle, checked_at)
      VALUES (?, ?, ?, 'falsch', ?, ?, ?, ?, ?)
      ON CONFLICT DO UPDATE SET schwere = excluded.schwere, beschreibung = excluded.beschreibung,
        empfehlung = excluded.empfehlung, quelle = excluded.quelle, checked_at = excluded.checked_at`);
    for (const r of rows) {
      const key = factKeyOf(r.stelle_a);
      if (!key) continue;
      ins.run(r.book_id, r.user_email, key, r.schwere, r.beschreibung, r.empfehlung, r.quelle,
        r.at || new Date().toISOString());
    }
  },
};
