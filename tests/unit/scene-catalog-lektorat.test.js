'use strict';
// db/scene-catalog.js#listScenesForBook — Lektorat-Wertung des Abschnitts an jeder
// Komplett-Szene (Lesezeit-Verknüpfung über page_id) und «Text geändert»-Flag.
// Getestet: jüngster Lauf MIT Szenen gewinnt, Läufe ohne Szenen verdecken ihn
// nicht, fremde User zählen nicht, Szenen ohne Abschnitt bleiben ohne Lektorat.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('scene-catalog-lektorat');
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const { listScenesForBook } = require('../../db/scene-catalog');

const USER = 'autor@x.ch';
const OTHER = 'fremd@x.ch';
const T0 = '2026-11-01T10:00:00.000Z';
const T1 = '2026-11-02T10:00:00.000Z';
const T2 = '2026-11-03T10:00:00.000Z';
const T3 = '2026-11-04T10:00:00.000Z';
let seq = 0;

function setup() {
  const bookId = 8000 + (++seq);
  for (const e of [USER, OTHER]) db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(e, 'A');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, 'B', T0, T0, USER);
  const chapterId = 91000 + (++seq);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(chapterId, bookId, 'K1', 0, T0);
  return { bookId, chapterId };
}

function addPage(bookId, chapterId, updatedAt) {
  const id = 61000 + (++seq);
  db.prepare('INSERT INTO pages (page_id, book_id, chapter_id, page_name, body_html, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, bookId, chapterId, 'S' + id, '<p>x</p>', updatedAt);
  return id;
}

function addSzene(bookId, chapterId, pageId, titel, updatedAt) {
  db.prepare(`INSERT INTO figure_scenes (book_id, user_email, titel, wertung, kommentar, chapter_id, page_id, sort_order, updated_at)
              VALUES (?, ?, ?, 'stark', 'k', ?, ?, ?, ?)`)
    .run(bookId, USER, titel, chapterId, pageId, ++seq, updatedAt);
}

function addCheck(bookId, pageId, checkedAt, szenen, email = USER) {
  db.prepare(`INSERT INTO page_checks (page_id, book_id, checked_at, error_count, errors_json, szenen_json, user_email)
              VALUES (?, ?, ?, 0, '[]', ?, ?)`)
    .run(pageId, bookId, checkedAt, szenen == null ? null : JSON.stringify(szenen), email);
  return db.prepare('SELECT MAX(id) AS id FROM page_checks').get().id;
}

test('jüngstes Lektorat mit Szenen hängt an der Szene; Lauf ohne Szenen verdeckt es nicht', () => {
  const { bookId, chapterId } = setup();
  const page = addPage(bookId, chapterId, T1);
  addSzene(bookId, chapterId, page, 'Ankunft', T2);
  addCheck(bookId, page, T0, [{ titel: 'alt', wertung: 'schwach', kommentar: 'a' }]);
  const checkId = addCheck(bookId, page, T1, [{ titel: 'neu', wertung: 'mittel', kommentar: 'b' }, { titel: 'zwei', wertung: 'stark' }]);
  addCheck(bookId, page, T2, []);      // z.B. lokaler Provider: keine Szenen
  addCheck(bookId, page, T3, null);
  addCheck(bookId, page, T3, [{ titel: 'fremd', wertung: 'stark' }], OTHER);

  const [s] = listScenesForBook(bookId, USER).szenen;
  assert.equal(s.lektorat.checked_at, T1);
  assert.equal(s.lektorat.check_id, checkId, 'Sprung in den Verlauf braucht die Check-ID');
  assert.deepEqual(s.lektorat.szenen, [
    { titel: 'neu', wertung: 'mittel', kommentar: 'b' },
    { titel: 'zwei', wertung: 'stark', kommentar: null },
  ]);
  assert.equal(s.text_geaendert, false, 'Abschnitt vor der Analyse zuletzt bearbeitet');
});

test('Text geändert: Abschnitt nach der Analyse bearbeitet; ohne Lektorat bleibt lektorat null', () => {
  const { bookId, chapterId } = setup();
  const page = addPage(bookId, chapterId, T3);
  addSzene(bookId, chapterId, page, 'Abschied', T2);
  addSzene(bookId, chapterId, null, 'ohne Abschnitt', T2);

  const [a, b] = listScenesForBook(bookId, USER).szenen;
  assert.equal(a.text_geaendert, true);
  assert.equal(a.lektorat, null);
  assert.equal(b.text_geaendert, false);
  assert.equal(b.lektorat, null);
});

test('kaputtes szenen_json wird übersprungen statt zu werfen', () => {
  const { bookId, chapterId } = setup();
  const page = addPage(bookId, chapterId, T0);
  addSzene(bookId, chapterId, page, 'X', T2);
  db.prepare(`INSERT INTO page_checks (page_id, book_id, checked_at, error_count, errors_json, szenen_json, user_email)
              VALUES (?, ?, ?, 0, '[]', '{kaputt', ?)`).run(page, bookId, T1, USER);
  const [s] = listScenesForBook(bookId, USER).szenen;
  assert.equal(s.lektorat, null);
});
