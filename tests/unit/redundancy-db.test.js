'use strict';
// Redundanz-Radar, DB-Seite (db/redundancy.js): letzter Lauf pro (Buch, User),
// ignorierte Paare (normiert a < b, Anker-Prüfung gegen Buch/User, CASCADE).

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('redundancy-db');

const { db } = require('../../db/connection');
require('../../db/migrations');
const appUsers = require('../../db/app-users');
const redundancyDb = require('../../db/redundancy');

const AUTOR = 'autor@redundancy.test';
const FREMD = 'fremd@redundancy.test';
appUsers.createUser({ email: AUTOR, displayName: 'Autor' });
appUsers.createUser({ email: FREMD, displayName: 'Fremd' });

const NOW = '2026-01-01T00:00:00Z';
function seedBook(bookId, owner) {
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?,?,?,?,?)')
    .run(bookId, `Buch ${bookId}`, NOW, NOW, owner);
}
function seedPage(pageId, bookId) {
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (?,?,?,?)').run(pageId, bookId, `S${pageId}`, NOW);
}
function seedFigure(bookId, name, email) {
  return db.prepare('INSERT INTO figures (book_id, fig_id, name, user_email, updated_at) VALUES (?,?,?,?,?)')
    .run(bookId, 'fig-' + name, name, email, NOW).lastInsertRowid;
}

seedBook(1, AUTOR);
seedBook(2, AUTOR);
seedPage(11, 1);
seedPage(12, 1);
seedPage(13, 1);
seedPage(21, 2);

test('saveRun/getLastRun: Upsert pro (Buch, User), Schwelle + Zeitpunkt aus der Zeile', () => {
  assert.equal(redundancyDb.getLastRun(1, AUTOR), null);
  redundancyDb.saveRun(1, AUTOR, 0.82, { pairs: [{ a_id: 11, b_id: 12, score: 0.9 }], threshold: 0.5 });
  redundancyDb.saveRun(1, AUTOR, 0.88, { pairs: [] });
  const run = redundancyDb.getLastRun(1, AUTOR);
  assert.deepEqual(run.pairs, []);
  assert.equal(run.threshold, 0.88);
  assert.match(run.createdAt, /Z$/);
  assert.equal(redundancyDb.getLastRun(1, FREMD), null, 'fremder User sieht den Lauf nicht');
});

test('addDismissal: normiert a < b, idempotent, pro User getrennt', () => {
  assert.equal(redundancyDb.addDismissal(1, AUTOR, 'page', 12, 11), true);
  assert.equal(redundancyDb.addDismissal(1, AUTOR, 'page', 11, 12), true, 'zweites Mal kein Fehler');
  assert.equal(redundancyDb.countDismissals(1, AUTOR), 1);
  assert.ok(redundancyDb.dismissalSets(1, AUTOR).page.has('11:12'));
  assert.equal(redundancyDb.countDismissals(1, FREMD), 0);
});

test('addDismissal: Seiten fremder Bücher, gleiche IDs und unbekannte kinds werden abgewiesen', () => {
  assert.equal(redundancyDb.addDismissal(1, AUTOR, 'page', 11, 21), false, 'Seite 21 liegt in Buch 2');
  assert.equal(redundancyDb.addDismissal(1, AUTOR, 'page', 11, 11), false);
  assert.equal(redundancyDb.addDismissal(1, AUTOR, 'scene', 11, 12), false);
  assert.equal(redundancyDb.addDismissal(1, AUTOR, 'page', 'x', 12), false);
});

test('addDismissal figure: nur eigene Figuren des Buchs', () => {
  const a = seedFigure(1, 'Anna', AUTOR);
  const b = seedFigure(1, 'Der Alte', AUTOR);
  const fremd = seedFigure(1, 'Fremdfigur', FREMD);
  assert.equal(redundancyDb.addDismissal(1, AUTOR, 'figure', b, a), true);
  assert.ok(redundancyDb.dismissalSets(1, AUTOR).figure.has(`${Math.min(a, b)}:${Math.max(a, b)}`));
  assert.equal(redundancyDb.addDismissal(1, AUTOR, 'figure', a, fremd), false);
});

test('removeDismissal + clearDismissals', () => {
  redundancyDb.addDismissal(1, AUTOR, 'page', 12, 13);
  assert.equal(redundancyDb.removeDismissal(1, AUTOR, 'page', 13, 12), 1);
  assert.equal(redundancyDb.dismissalSets(1, AUTOR).page.has('12:13'), false);
  assert.ok(redundancyDb.clearDismissals(1, AUTOR) >= 1);
  assert.equal(redundancyDb.countDismissals(1, AUTOR), 0);
});

test('CASCADE: Seite löschen räumt das ignorierte Paar ab', () => {
  redundancyDb.addDismissal(1, AUTOR, 'page', 11, 13);
  db.prepare('DELETE FROM pages WHERE page_id = ?').run(13);
  assert.equal(redundancyDb.countDismissals(1, AUTOR), 0);
});
