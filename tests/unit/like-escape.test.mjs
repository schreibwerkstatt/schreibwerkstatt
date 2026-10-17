// LIKE-Muster aus freiem Text: `%`, `_` und das Escape-Zeichen `\` selbst sind
// Text, keine Platzhalter. Geprueft am Helper und an den zwei Konsumenten
// (Content-Store-Fallback-Suche, Orts-Lookup des Buch-Chats mit KI-Namen).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('like-escape');

require('../../db/migrations');
const { db } = require('../../db/connection');
const { likeContains, escapeLike } = require('../../db/like-escape');
const contentStore = require('../../lib/content-store');
const { findLocationByName } = require('../../db/book-chat/catalog');

const now = new Date().toISOString();
db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(9601, 'B', now, now);

test('escapeLike maskiert \\ % _', () => {
  assert.equal(escapeLike('a\\b%c_d'), 'a\\\\b\\%c\\_d');
  assert.equal(likeContains('x'), '%x%');
  assert.equal(escapeLike(null), '');
});

test('searchPages: Backslash im Suchtext ist Text', async () => {
  await contentStore.createPage({ book_id: 9601, name: 'Pfad C:\\tmp', html: '<p>Datei</p>' });
  await contentStore.createPage({ book_id: 9601, name: 'Pfad Ctmp', html: '<p>anders</p>' });
  const hits = await contentStore.searchPages('C:\\tmp', { bookId: 9601 });
  assert.deepEqual(hits.map(h => h.name), ['Pfad C:\\tmp']);
  // Ohne Escape des `\` maskierte ein endender Backslash das angehaengte `%`.
  const tail = await contentStore.searchPages('Pfad C:\\', { bookId: 9601 });
  assert.deepEqual(tail.map(h => h.name), ['Pfad C:\\tmp']);
  assert.deepEqual(await contentStore.searchPages('%%', { bookId: 9601 }), []);
});

test('findLocationByName: %/_ aus KI-Namen matchen nicht beliebig', () => {
  const ins = db.prepare("INSERT INTO locations (book_id, loc_id, name, updated_at, user_email) VALUES (9601, ?, ?, ?, NULL)");
  ins.run('l1', 'Bahnhof', now);
  ins.run('l2', '100% Bar', now);
  assert.equal(findLocationByName(9601, null, '%').name, '100% Bar');
  assert.equal(findLocationByName(9601, null, '_ahnhof'), undefined);
  assert.equal(findLocationByName(9601, null, 'Bahn').name, 'Bahnhof');
  assert.equal(findLocationByName(9601, null, 'x\\'), undefined);
});
