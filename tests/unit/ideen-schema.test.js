'use strict';
// ideen-Tabelle: CRUD + User-Isolation + Anker-CHECK (hoechstens page_id ODER
// chapter_id; keins = Buch-Idee)
// gegen frische In-Memory-DB. Wir replizieren das Migrations-DDL hier, damit
// der Test ohne schreibwerkstatt.db läuft.
//
// Gegenstand sind hier die reinen Tabellen-Zusagen (Anker-CHECK, Stufen-CHECK,
// Ownership im WHERE). Die Datenschicht darüber (db/ideen.js: Board-Abfrage,
// Verknüpfungen, Rückwärts-Lesung) prüft tests/unit/ideen-db.test.js gegen das
// ECHTE migrierte Schema — dort, wo FK-Kanten und Indexe mitwirken.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.prepare(`
    CREATE TABLE ideen (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id     INTEGER NOT NULL,
      page_id     INTEGER,
      chapter_id  INTEGER,
      user_email  TEXT NOT NULL,
      content     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'offen'
                    CHECK(status IN ('offen','in_arbeit','erledigt','verworfen')),
      status_at   TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      CHECK (page_id IS NULL OR chapter_id IS NULL)
    )
  `).run();
  return db;
}

test('ideen: Insert + Select pro User isoliert', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ideen (book_id, page_id, user_email, content, created_at, updated_at)
              VALUES (1, 10, 'a@x.de', 'Idee A', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO ideen (book_id, page_id, user_email, content, created_at, updated_at)
              VALUES (1, 10, 'b@x.de', 'Idee B', ?, ?)`).run(now, now);
  const a = db.prepare('SELECT content FROM ideen WHERE page_id = ? AND user_email = ?').all(10, 'a@x.de');
  const b = db.prepare('SELECT content FROM ideen WHERE page_id = ? AND user_email = ?').all(10, 'b@x.de');
  assert.deepEqual(a.map(r => r.content), ['Idee A']);
  assert.deepEqual(b.map(r => r.content), ['Idee B']);
});

test('ideen: getOpenIdeen-Filter — offen UND in_arbeit, nicht verworfen', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  const ins = (content, status) => db.prepare(
    `INSERT INTO ideen (book_id, page_id, user_email, content, status, created_at, updated_at)
     VALUES (1, 10, 'u@x.de', ?, ?, ?, ?)`
  ).run(content, status, now, now);
  ins('offen', 'offen');
  ins('dran', 'in_arbeit');
  ins('fertig', 'erledigt');
  ins('weg', 'verworfen');
  const open = db.prepare(
    `SELECT content FROM ideen
      WHERE page_id = ? AND user_email = ? AND status IN ('offen','in_arbeit')
      ORDER BY id ASC`
  ).all(10, 'u@x.de');
  assert.deepEqual(open.map(r => r.content), ['offen', 'dran']);
});

test('ideen: Default-Stufe ist `offen`', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO ideen (book_id, page_id, user_email, content, created_at, updated_at)
                          VALUES (1, 10, 'u@x.de', 'X', ?, ?)`).run(now, now);
  const row = db.prepare('SELECT status, status_at FROM ideen WHERE id = ?').get(ins.lastInsertRowid);
  assert.equal(row.status, 'offen');
  assert.equal(row.status_at, null);
});

test('ideen: eine Stufe ausserhalb des CHECK kommt nicht in die Tabelle', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  assert.throws(() => {
    db.prepare(`INSERT INTO ideen (book_id, page_id, user_email, content, status, created_at, updated_at)
                VALUES (1, 10, 'u@x.de', 'X', 'quatsch', ?, ?)`).run(now, now);
  }, /CHECK constraint failed/);
});

test('ideen: DELETE nur eigene Zeilen (Ownership-Pattern)', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO ideen (book_id, page_id, user_email, content, created_at, updated_at)
                          VALUES (1, 10, 'a@x.de', 'A', ?, ?)`).run(now, now);
  const id = ins.lastInsertRowid;
  // fremder User → 0 Treffer
  const r1 = db.prepare('DELETE FROM ideen WHERE id = ? AND user_email = ?').run(id, 'b@x.de');
  assert.equal(r1.changes, 0);
  // eigener User → gelöscht
  const r2 = db.prepare('DELETE FROM ideen WHERE id = ? AND user_email = ?').run(id, 'a@x.de');
  assert.equal(r2.changes, 1);
});

test('ideen: Anker-CHECK — Kapitel-Idee mit chapter_id alleine erlaubt', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ideen (book_id, chapter_id, user_email, content, created_at, updated_at)
              VALUES (1, 5, 'u@x.de', 'Kapitel-Idee', ?, ?)`).run(now, now);
  const row = db.prepare('SELECT page_id, chapter_id FROM ideen WHERE user_email = ?').get('u@x.de');
  assert.equal(row.page_id, null);
  assert.equal(row.chapter_id, 5);
});

test('ideen: Anker-CHECK — beide gesetzt → CHECK schlägt fehl', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  assert.throws(() => {
    db.prepare(`INSERT INTO ideen (book_id, page_id, chapter_id, user_email, content, created_at, updated_at)
                VALUES (1, 10, 5, 'u@x.de', 'Beides', ?, ?)`).run(now, now);
  }, /CHECK constraint failed/);
});

test('ideen: keins gesetzt → Buch-Idee erlaubt', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ideen (book_id, user_email, content, created_at, updated_at)
              VALUES (1, 'u@x.de', 'Buch-Idee', ?, ?)`).run(now, now);
  const row = db.prepare('SELECT page_id, chapter_id FROM ideen WHERE user_email = ?').get('u@x.de');
  assert.equal(row.page_id, null);
  assert.equal(row.chapter_id, null);
});

test('ideen: Counts pro kind (page vs chapter)', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO ideen (book_id, page_id, user_email, content, created_at, updated_at)
              VALUES (1, 10, 'u@x.de', 'P1', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO ideen (book_id, page_id, user_email, content, created_at, updated_at)
              VALUES (1, 10, 'u@x.de', 'P2', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO ideen (book_id, chapter_id, user_email, content, created_at, updated_at)
              VALUES (1, 5, 'u@x.de', 'C1', ?, ?)`).run(now, now);

  const pageCounts = db.prepare(`
    SELECT page_id AS scope_id, COUNT(*) AS n FROM ideen
    WHERE book_id = ? AND user_email = ? AND status IN ('offen','in_arbeit') AND page_id IS NOT NULL
    GROUP BY page_id
  `).all(1, 'u@x.de');
  assert.deepEqual(pageCounts, [{ scope_id: 10, n: 2 }]);

  const chapCounts = db.prepare(`
    SELECT chapter_id AS scope_id, COUNT(*) AS n FROM ideen
    WHERE book_id = ? AND user_email = ? AND status IN ('offen','in_arbeit') AND chapter_id IS NOT NULL
    GROUP BY chapter_id
  `).all(1, 'u@x.de');
  assert.deepEqual(chapCounts, [{ scope_id: 5, n: 1 }]);
});
