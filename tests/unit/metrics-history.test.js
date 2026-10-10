'use strict';
// /metrics/history.json (lib/metrics/history.js): Tagesreihen aus
// book_stats_history unter den Namen der Live-Kennzahlen.

const test = require('node:test');
const assert = require('node:assert');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('metrics-history');
require('../../db/migrations').runMigrations();
const { db } = require('../../db/connection');

const { collectHistoryJson } = require('../../lib/metrics/history');
const { localIsoDate, isoAddDays } = require('../../lib/local-date');

const today = localIsoDate(new Date());
const day = (n) => isoAddDays(today, -n);

function seed() {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO app_users (email, display_name, status, global_role, created_at)
              VALUES (?,?,?,?,?)`).run('a@x.test', 'Anna', 'active', 'user', now);
  db.prepare(`INSERT INTO app_users (email, display_name, status, global_role, created_at)
              VALUES (?,?,?,?,?)`).run('b@x.test', 'Ben', 'suspended', 'user', now);
  const book = db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?,?,?,?,?)');
  book.run(1, 'Geheimer Titel', now, now, 'a@x.test');
  book.run(2, 'Zweites', now, now, 'b@x.test');
  const snap = db.prepare('INSERT INTO book_stats_history (book_id, recorded_at, page_count, words, chars, tok) VALUES (?,?,?,?,?,?)');
  // Buch 1: Monatsend-Stand vor dem Tagesfenster, dann drei Tage am Stueck.
  snap.run(1, day(400), 1, 100, 600, 0);
  snap.run(1, day(3), 1, 200, 1200, 0);
  snap.run(1, day(2), 1, 300, 1800, 0);
  snap.run(1, day(1), 1, 250, 1500, 0);   // gestrichen: netto negativ
  // Buch 2: erster Snapshot vorgestern (Import, zaehlt nicht als geschrieben), leer.
  snap.run(2, day(2), 0, 0, 0, 0);
  snap.run(2, day(1), 1, 50, 300, 0);
  snap.run(1, today, 1, 999, 9999, 0);    // heute: fehlt
  const wt = db.prepare('INSERT INTO writing_time (user_email, book_id, date, seconds) VALUES (?,?,?,?)');
  wt.run('a@x.test', 1, day(2), 1200);
  wt.run('b@x.test', 2, day(2), 600);
  wt.run('a@x.test', 1, today, 60);
}
seed();

const points = (j, name, user) =>
  Object.fromEntries(j.series.find(s => s.name === name && (s.labels.user || null) === (user || null))?.points || []);

test('Stand je Datum mit Fortschreibung, heute fehlt', () => {
  const j = collectHistoryJson({ includeUsers: true });
  assert.strictEqual(j.schema, 1);
  assert.deepStrictEqual(points(j, 'sw_chars'), { [day(400)]: 600, [day(3)]: 1200, [day(2)]: 1800, [day(1)]: 1800 });
  assert.deepStrictEqual(points(j, 'sw_books'), { [day(400)]: 1, [day(3)]: 1, [day(2)]: 2, [day(1)]: 2 });
  assert.deepStrictEqual(points(j, 'sw_books_written'), { [day(400)]: 1, [day(3)]: 1, [day(2)]: 1, [day(1)]: 2 });
  assert.strictEqual(points(j, 'sw_normseiten')[day(1)], 1);
});

test('Netto je Tag nur im taeglichen Fenster, Import zaehlt nicht', () => {
  const j = collectHistoryJson({ includeUsers: true });
  // day(3) hat keinen Vortag (davor nur der Monatsend-Stand) → kein Netto.
  assert.deepStrictEqual(points(j, 'sw_chars_today'), { [day(2)]: 600, [day(1)]: -300 + 300 });
  assert.deepStrictEqual(points(j, 'sw_words_today'), { [day(2)]: 100, [day(1)]: -50 + 50 });
});

test('Pro User: nur aktive, nur mit includeUsers, keine Titel', () => {
  const j = collectHistoryJson({ includeUsers: true });
  assert.deepStrictEqual(points(j, 'sw_user_chars', 'a@x.test'), { [day(400)]: 600, [day(3)]: 1200, [day(2)]: 1800, [day(1)]: 1500 });
  assert.deepStrictEqual(points(j, 'sw_user_chars_today', 'a@x.test'), { [day(2)]: 600, [day(1)]: -300 });
  assert.strictEqual(j.series.find(s => s.name === 'sw_user_chars').labels.user_name, 'Anna');
  assert.ok(!j.series.some(s => s.labels.user === 'b@x.test'), 'gesperrte User fehlen');
  assert.doesNotMatch(JSON.stringify(j), /Geheimer Titel/);

  const plain = collectHistoryJson();
  assert.strictEqual(plain.includes_users, false);
  assert.ok(!plain.series.some(s => s.name.startsWith('sw_user_')));
});

test('Schreibzeit je Tag, gesamt und je aktivem User', () => {
  const j = collectHistoryJson({ includeUsers: true });
  assert.deepStrictEqual(points(j, 'sw_writing_seconds_today'), { [day(2)]: 1800 });
  assert.deepStrictEqual(points(j, 'sw_user_writing_seconds_today', 'a@x.test'), { [day(2)]: 1200 });
  assert.deepStrictEqual(points(j, 'sw_lektorat_seconds_today'), {});
});
