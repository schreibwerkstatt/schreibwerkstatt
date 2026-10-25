'use strict';
// Migration 0341: Freitext book_publication.series/series_index → book_series.
// Gruppiert je Besitzer + Reihenname (ohne Gross-/Kleinschreibung), ordnet nach
// series_index (numerisch, leer ans Ende), lässt bestehende Mitgliedschaften stehen
// und entfernt danach die beiden Spalten.

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const mig = require('../../db/migrations/0341-series-freetext-to-book-series');

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE books (book_id INTEGER PRIMARY KEY, name TEXT, owner_email TEXT);
    CREATE TABLE book_publication (book_id INTEGER PRIMARY KEY, publisher TEXT, series TEXT, series_index TEXT);
    CREATE TABLE book_series (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT, updated_at TEXT);
    CREATE TABLE book_series_members (series_id INTEGER, book_id INTEGER UNIQUE, position INTEGER, PRIMARY KEY (series_id, book_id));
  `);
  const book = db.prepare('INSERT INTO books VALUES (?, ?, ?)');
  const pub = db.prepare('INSERT INTO book_publication VALUES (?, ?, ?, ?)');
  [[1, 'a@x'], [2, 'a@x'], [3, 'a@x'], [4, 'b@x'], [5, 'a@x'], [6, 'a@x']].forEach(([id, o]) => book.run(id, `B${id}`, o));
  pub.run(1, 'Verlag', 'Die Saga', '2');
  pub.run(2, null, ' die saga ', '1.5');
  pub.run(3, null, 'Die Saga', '');
  pub.run(4, null, 'Die Saga', '1');   // anderer Besitzer → eigene Reihe
  pub.run(5, null, '', '3');           // keine Reihe
  pub.run(6, null, 'Schon drin', '1'); // steht schon in einer Reihe
  const s = db.prepare("INSERT INTO book_series (name) VALUES ('Bestand')").run().lastInsertRowid;
  db.prepare('INSERT INTO book_series_members VALUES (?, 6, 1)').run(s);
  return db;
}

test('0341: Freitext wird zu Reihen je Besitzer, Ordnung nach series_index, Spalten weg', () => {
  const db = setup();
  mig.up(db);
  const members = db.prepare(`
    SELECT s.id AS series_id, s.name, m.book_id, m.position FROM book_series_members m JOIN book_series s ON s.id = m.series_id
     ORDER BY s.id, m.position`).all();
  const by = (bookId) => members.find(m => m.book_id === bookId);
  assert.equal(by(2).position, 1);
  assert.equal(by(1).position, 2);
  assert.equal(by(3).position, 3, 'leerer Index ans Ende');
  assert.equal(by(1).series_id, by(2).series_id);
  assert.notEqual(by(4).series_id, by(1).series_id, 'anderer Besitzer → eigene Reihe');
  assert.equal(by(4).position, 1);
  assert.equal(by(5), undefined);
  assert.equal(by(6).name, 'Bestand');
  const cols = db.prepare("SELECT name FROM pragma_table_info('book_publication')").all().map(c => c.name);
  assert.deepEqual(cols, ['book_id', 'publisher']);
  // Idempotent: ein zweiter Lauf tut nichts.
  mig.up(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM book_series').get().n, 3);
});
