'use strict';
// db/songs.js#saveSongsToDb + phases/orte.js#dedupeSongsWithinRun — Identitaet
// der Musikbibliothek ueber Komplettanalyse-Laeufe.
//
// Die Komplettanalyse nummeriert die Songs jedes Laufs neu (`song_1…N`). Diese
// lauf-interne id darf nicht als Identitaet dienen: sonst ueberschreibt ein neuer
// Song mit derselben Nummer die Zeile eines alten, und Suchindex/Deep-Links zeigen
// auf den falschen Titel. Identitaet ist normalisierter Titel+Interpret.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('songs-save');

require('../../db/migrations');
const { db } = require('../../db/connection');
const { saveSongsToDb, listSongsForBook, songKey } = require('../../db/songs');
const { dedupeSongsWithinRun, buildFallbackSongs } = require('../../routes/jobs/komplett/phases/orte');

const USER = 'autor@x.ch';
const NOW = new Date().toISOString();
let seq = 0;

function newBook() {
  const bookId = 8800 + (++seq);
  db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(USER, 'A');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(bookId, 'Buch ' + bookId, NOW, NOW, USER);
  const chapterId = 88000 + (++seq);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(chapterId, bookId, 'Kapitel 1', 0, NOW);
  return { bookId, chapterId };
}

const rowsOf = bookId => db.prepare('SELECT id, song_uid, titel FROM songs WHERE book_id = ? ORDER BY id').all(bookId);

test('Zweiter Lauf in anderer Reihenfolge: jeder Song behaelt songs.id und song_uid', () => {
  const { bookId } = newBook();
  saveSongsToDb(bookId, [
    { id: 'song_1', titel: 'Heroes', interpret: 'David Bowie' },
    { id: 'song_2', titel: 'Imagine', interpret: 'John Lennon' },
  ], USER);
  const before = Object.fromEntries(rowsOf(bookId).map(r => [r.titel, r]));

  // Lauf 2: Reihenfolge vertauscht, lauf-interne ids neu vergeben, Schreibweise variiert.
  saveSongsToDb(bookId, [
    { id: 'song_1', titel: 'imagine', interpret: 'John  Lennon' },
    { id: 'song_2', titel: '«Heroes»', interpret: 'david bowie' },
  ], USER);
  const after = Object.fromEntries(rowsOf(bookId).map(r => [r.titel.replace(/[«»]/g, '').toLowerCase(), r]));

  assert.equal(after.heroes.id, before.Heroes.id);
  assert.equal(after.heroes.song_uid, before.Heroes.song_uid);
  assert.equal(after.imagine.id, before.Imagine.id);
  assert.equal(after.imagine.song_uid, before.Imagine.song_uid);
});

test('Verschwundener Song wird geloescht, neuer bekommt eine freie song_uid', () => {
  const { bookId } = newBook();
  saveSongsToDb(bookId, [
    { id: 'song_1', titel: 'Alt', interpret: 'A' },
    { id: 'song_2', titel: 'Bleibt', interpret: 'B' },
  ], USER);
  const bleibt = rowsOf(bookId).find(r => r.titel === 'Bleibt');

  saveSongsToDb(bookId, [
    { id: 'song_1', titel: 'Neu', interpret: 'C' },
    { id: 'song_2', titel: 'Bleibt', interpret: 'B' },
  ], USER);
  const rows = rowsOf(bookId);
  assert.deepEqual(rows.map(r => r.titel).sort(), ['Bleibt', 'Neu']);
  const neu = rows.find(r => r.titel === 'Neu');
  assert.notEqual(neu.song_uid, bleibt.song_uid);
  assert.equal(rows.find(r => r.titel === 'Bleibt').id, bleibt.id);
  assert.equal(new Set(rows.map(r => r.song_uid)).size, rows.length);
});

test('Doppelte oder fehlende Eingabe-ids sprengen die Transaktion nicht', () => {
  const { bookId } = newBook();
  assert.doesNotThrow(() => saveSongsToDb(bookId, [
    { id: 'song_1', titel: 'Eins' },
    { id: 'song_1', titel: 'Zwei' },
    { titel: 'Drei' },
    { titel: '' },
  ], USER));
  assert.deepEqual(rowsOf(bookId).map(r => r.titel), ['Eins', 'Zwei', 'Drei']);
});

test('listSongsForBook: Kapitel-Bezug, juengster updated_at, kein szenen-Feld', () => {
  const { bookId, chapterId } = newBook();
  saveSongsToDb(bookId, [
    { id: 'song_1', titel: 'Heroes', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 2 }] },
  ], USER);
  db.prepare("UPDATE songs SET updated_at = '2020-01-01T00:00:00.000Z' WHERE book_id = ?").run(bookId);
  saveSongsToDb(bookId, [
    { id: 'song_1', titel: 'Heroes', kapitel: [{ name: 'Kapitel 1', haeufigkeit: 2 }] },
    { id: 'song_2', titel: 'Neu' },
  ], USER);
  const r = listSongsForBook(bookId, USER);
  assert.equal(r.songs.length, 2);
  assert.deepEqual(r.songs[0].kapitel, [{ chapter_id: chapterId, name: 'Kapitel 1', haeufigkeit: 2 }]);
  assert.equal(r.songs[0].szenen, undefined);
  assert.ok(r.updated_at > '2020-01-01T00:00:00.000Z');
  assert.equal(listSongsForBook(bookId, 'fremd@x.ch'), null);
});

test('songKey: Anfuehrungszeichen, Gross/Klein und Leerraum zaehlen nicht', () => {
  assert.equal(songKey({ titel: '„Heroes"', interpret: ' David  Bowie ' }), songKey({ titel: 'heroes', interpret: 'david bowie' }));
  assert.notEqual(songKey({ titel: 'Heroes', interpret: 'Bowie' }), songKey({ titel: 'Heroes', interpret: 'Wallflowers' }));
  assert.equal(songKey({ titel: '  ' }), null);
});

test('dedupeSongsWithinRun: fuehrt Dubletten zusammen und nummeriert eindeutig', () => {
  const out = dedupeSongsWithinRun([
    { id: 'x', titel: 'Heroes', interpret: 'Bowie', figuren: ['fig_1'], kapitel: [{ name: 'K1', haeufigkeit: 1 }] },
    { id: 'x', titel: 'heroes', interpret: 'bowie', figuren: ['fig_2'], beschreibung: 'im Auto',
      kapitel: [{ name: 'K1', haeufigkeit: 3 }, { name: 'K2', haeufigkeit: 1 }] },
    { titel: 'Imagine' },
  ]);
  assert.deepEqual(out.map(s => s.id), ['song_1', 'song_2']);
  assert.deepEqual(out[0].figuren, ['fig_1', 'fig_2']);
  assert.deepEqual(out[0].kapitel, [{ name: 'K1', haeufigkeit: 3 }, { name: 'K2', haeufigkeit: 1 }]);
  assert.equal(out[0].beschreibung, 'im Auto');
});

test('buildFallbackSongs: Figurennamen aufgeloest, ueber Kapitel zusammengefuehrt', () => {
  const out = buildFallbackSongs([
    { songs: [{ titel: 'Heroes', interpret: 'Bowie', figuren_namen: ['Anna'] }] },
    { songs: [{ titel: 'HEROES', interpret: 'Bowie', figuren_namen: ['Ben'] }] },
  ], { Anna: 'fig_a', Ben: 'fig_b' }, { anna: 'fig_a', ben: 'fig_b' });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].figuren, ['fig_a', 'fig_b']);
});
