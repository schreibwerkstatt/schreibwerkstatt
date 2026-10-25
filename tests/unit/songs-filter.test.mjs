// Unit-Tests für Songs-Filter (Musikbibliothek).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { applySongsFilters } = await import('../../public/js/app/app-ui.js');

const SONGS = [
  {
    id: 'song_1', titel: 'Heroes', interpret: 'David Bowie', genre: 'Rock',
    kontext_typ: 'hört', stimmung: 'melancholisch', beschreibung: 'Im Auto',
    kapitel: [{ chapter_id: 1, name: 'Kapitel 1', haeufigkeit: 2 }],
    figuren: ['fig_1', { fig_id: 'fig_2', kontext_typ: 'spielt' }],
  },
  {
    id: 'song_2', titel: 'Mondscheinsonate', interpret: 'Beethoven', genre: 'Klassik',
    kontext_typ: 'spielt', stimmung: 'ruhig', beschreibung: '',
    kapitel: [{ chapter_id: 2, name: 'Kapitel 2', haeufigkeit: 1 }],
    figuren: ['fig_3'],
  },
  {
    id: 'song_3', titel: 'Imagine', interpret: 'John Lennon', genre: 'Pop',
    kontext_typ: 'leitmotiv', stimmung: '', beschreibung: 'Wiederkehrendes Motiv',
    kapitel: [{ chapter_id: 1, name: 'Kapitel 1', haeufigkeit: 3 }, { chapter_id: 3, name: 'Kapitel 3', haeufigkeit: 1 }],
    figuren: [],
  },
];

const EMPTY = { suche: '', figurId: '', kapitelId: '', genre: '', kontextTyp: '' };

test('applySongsFilters: kein Filter → alle Songs', () => {
  const out = applySongsFilters(SONGS, EMPTY);
  assert.equal(out.length, 3);
});

test('applySongsFilters: Suche matcht Titel case-insensitive', () => {
  const out = applySongsFilters(SONGS, { ...EMPTY, suche: 'HEROES' });
  assert.deepEqual(out.map(s => s.id), ['song_1']);
});

test('applySongsFilters: Suche matcht Interpret', () => {
  const out = applySongsFilters(SONGS, { ...EMPTY, suche: 'beethoven' });
  assert.deepEqual(out.map(s => s.id), ['song_2']);
});

test('applySongsFilters: Suche matcht Beschreibung', () => {
  const out = applySongsFilters(SONGS, { ...EMPTY, suche: 'motiv' });
  assert.deepEqual(out.map(s => s.id), ['song_3']);
});

test('applySongsFilters: Genre-Filter exakt', () => {
  const out = applySongsFilters(SONGS, { ...EMPTY, genre: 'Klassik' });
  assert.deepEqual(out.map(s => s.id), ['song_2']);
});

test('applySongsFilters: kontextTyp-Filter', () => {
  const out = applySongsFilters(SONGS, { ...EMPTY, kontextTyp: 'leitmotiv' });
  assert.deepEqual(out.map(s => s.id), ['song_3']);
});

test('applySongsFilters: figurId matcht String-Form (s.figuren = ["fig_1"])', () => {
  const out = applySongsFilters(SONGS, { ...EMPTY, figurId: 'fig_3' });
  assert.deepEqual(out.map(s => s.id), ['song_2']);
});

test('applySongsFilters: figurId matcht Object-Form (s.figuren = [{fig_id, kontext_typ}])', () => {
  const out = applySongsFilters(SONGS, { ...EMPTY, figurId: 'fig_2' });
  assert.deepEqual(out.map(s => s.id), ['song_1']);
});

test('applySongsFilters: Kapitel-Filter matcht Kapitelname', () => {
  const out = applySongsFilters(SONGS, { ...EMPTY, kapitelId: 1 });
  assert.deepEqual(out.map(s => s.id).sort(), ['song_1', 'song_3']);
});

test('applySongsFilters: kombinierter Filter (Kapitel + Genre)', () => {
  const out = applySongsFilters(SONGS, { ...EMPTY, kapitelId: '1', genre: 'Rock' });
  assert.deepEqual(out.map(s => s.id), ['song_1']);
});

test('applySongsFilters: leeres Songs-Array', () => {
  assert.deepEqual(applySongsFilters([], EMPTY), []);
});

test('applySongsFilters: figurId ohne Treffer → leer', () => {
  const out = applySongsFilters(SONGS, { ...EMPTY, figurId: 'fig_99' });
  assert.deepEqual(out, []);
});
