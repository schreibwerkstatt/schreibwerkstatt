'use strict';
// Migration 0336: der Klappentext hat danach EINEN Ort (book_publication.description).
// Übernommen wird nur in ein leeres Ziel, ein gesetzter Publikations-Klappentext
// gewinnt; books.description und coverSpec.blurb sind danach leer.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { SQUASHED_SCHEMA } = require('../../db/squashed-schema');
const migration = require('../../db/migrations/0336-klappentext-konsolidieren');

const NOW = '2026-10-25T10:00:00.000Z';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SQUASHED_SCHEMA);
  // Stand vor 0342: books.description gab es noch (0336 liest sie).
  db.exec('ALTER TABLE books ADD COLUMN description TEXT');
  db.prepare(`INSERT INTO app_users (email) VALUES ('a@x.ch')`).run();
  return db;
}

function addBook(db, id, description) {
  db.prepare(`INSERT INTO books (book_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, `Buch ${id}`, description, NOW, NOW);
}

function addProfile(db, bookId, blurb, { isDefault = 0, updatedAt = NOW } = {}) {
  const config = { coverSpec: { pageCount: 100, ...(blurb === undefined ? {} : { blurb }) } };
  db.prepare(`INSERT INTO pdf_export_profile (book_id, kind, user_email, name, config_json, is_default, updated_at)
              VALUES (?, 'book', 'a@x.ch', ?, ?, ?, ?)`)
    .run(bookId, `P${Math.random()}`, JSON.stringify(config), isDefault, updatedAt);
}

const desc = (db, id) => db.prepare(`SELECT description FROM book_publication WHERE book_id = ?`).get(id)?.description ?? null;

test('books.description wandert in einen leeren Publikations-Klappentext', () => {
  const db = freshDb();
  addBook(db, 1, '  Alter Text  ');
  migration.up(db);
  assert.equal(desc(db, 1), 'Alter Text');
  assert.equal(db.prepare(`SELECT description FROM books WHERE book_id = 1`).get().description, null);
});

test('gesetzter Publikations-Klappentext gewinnt gegen books.description und blurb', () => {
  const db = freshDb();
  addBook(db, 2, 'Altbestand');
  db.prepare(`INSERT INTO book_publication (book_id, description, created_at, updated_at) VALUES (2, 'Publikation', ?, ?)`).run(NOW, NOW);
  addProfile(db, 2, 'Profil-Blurb');
  migration.up(db);
  assert.equal(desc(db, 2), 'Publikation');
});

test('blurb: Standardprofil vor dem zuletzt geänderten, danach aus allen Profilen entfernt', () => {
  const db = freshDb();
  addBook(db, 3, null);
  addProfile(db, 3, 'Neuer', { updatedAt: '2026-10-20T00:00:00.000Z' });
  addProfile(db, 3, 'Standard', { isDefault: 1, updatedAt: '2026-01-01T00:00:00.000Z' });
  addProfile(db, 3, undefined);
  migration.up(db);
  assert.equal(desc(db, 3), 'Standard');
  const left = db.prepare(`SELECT COUNT(*) AS n FROM pdf_export_profile
                           WHERE json_type(config_json, '$.coverSpec.blurb') IS NOT NULL`).get().n;
  assert.equal(left, 0);
  // Übrige coverSpec-Felder bleiben.
  const pc = db.prepare(`SELECT json_extract(config_json, '$.coverSpec.pageCount') AS pc FROM pdf_export_profile LIMIT 1`).get().pc;
  assert.equal(pc, 100);
});

test('Buch ohne irgendeinen Klappentext bekommt keine Publikationszeile', () => {
  const db = freshDb();
  addBook(db, 4, '   ');
  addProfile(db, 4, '');
  migration.up(db);
  assert.equal(desc(db, 4), null);
});
