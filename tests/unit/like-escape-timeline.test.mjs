// findDatedEvents (Buch-Chat, get_figure_age): Suchtext kommt von der KI —
// `%`, `_` und `\` sind Text, keine LIKE-Platzhalter (db/like-escape.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('like-escape-timeline');

require('../../db/migrations');
const { db } = require('../../db/connection');
const { findDatedEvents } = require('../../db/book-chat/timeline');

const now = new Date().toISOString();
const U = 'tl@test.dev';
db.prepare('INSERT INTO app_users (email, created_at) VALUES (?, ?)').run(U, now);
db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(9611, 'B', now, now);
const figId = db.prepare(`INSERT INTO figures (book_id, fig_id, name, updated_at, user_email)
                          VALUES (9611, 'f1', 'Anna', ?, ?)`).run(now, U).lastInsertRowid;
const ins = db.prepare(`INSERT INTO figure_events (figure_id, datum, datum_year, ereignis) VALUES (?, '1990', 1990, ?)`);
ins.run(figId, 'Umzug nach Bern');
ins.run(figId, '100% Rabatt');
ins.run(figId, 'Pfad C:\\tmp');

const names = (needle) => findDatedEvents(9611, U, needle).map(r => r.ereignis).sort();

test('findDatedEvents: Teilstring normal', () => {
  assert.deepEqual(names('Bern'), ['Umzug nach Bern']);
});

test('findDatedEvents: % und _ matchen nicht beliebig', () => {
  assert.deepEqual(names('%'), ['100% Rabatt']);
  assert.deepEqual(names('_mzug'), []);
});

test('findDatedEvents: Backslash ist Text, auch am Ende', () => {
  assert.deepEqual(names('C:\\'), ['Pfad C:\\tmp']);
  assert.deepEqual(names('x\\'), []);
});
