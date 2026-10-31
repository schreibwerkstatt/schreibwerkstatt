// Speicher-Orchestrierung der Bucheinstellungen (public/js/book/book-settings/save-paths.js):
// Normalform des Vergleichs, Ungespeichert-Erkennung je Pfad, «nur Geändertes
// speichern», Pflichtfeld sperrt nur den eigenen Pfad, Buch-Bindung.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SAVE_PATHS, snapshotKey, savePathMethods } from '../../public/js/book/book-settings/save-paths.js';
import { resolveDailyGoal, DEFAULT_DAILY_GOAL_CHARS } from '../../public/js/utils/format.js';

const REPO = new URL('../../', import.meta.url).pathname;

function fakeCard(overrides = {}) {
  globalThis.Alpine = { store: () => ({ selectedBookId: '7' }) };
  globalThis.window = { __app: { t: (k) => k } };
  const saved = [];
  const card = {
    ...savePathMethods,
    _formBookId: '7',
    _saveBaseline: {},
    _flashTimers: {},
    bookSettingsTab: 'publication',
    bookSettingsLoading: false,
    bookSettingsError: '',
    bookSettingsBuchtyp: 'roman',
    categoryPool: [],
    bookCategoryId: '',
    exposeDirty: false,
    form: { title: 'A', isbn: '' },
    pub: { description: 'x' },
    _settingsSnapshot() { return this.form; },
    _publicationSnapshot() { return this.pub; },
    _citationSnapshot() { return {}; },
    _xrefSnapshot() { return {}; },
    _researchSnapshot() { return {}; },
    _schoolSnapshot() { return {}; },
    ...overrides,
  };
  for (const p of SAVE_PATHS) {
    if (p.loaded) card[p.loaded] = true;
    card[p.saving] = false; card[p.saved] = false; card[p.error] = '';
    card[p.save] = async (bookId) => { saved.push([p.key, bookId]); card._markClean(p.key); return true; };
  }
  for (const p of SAVE_PATHS) if (!p.dirty) card._markClean(p.key);
  return { card, saved };
}

test('snapshotKey: Zahl/String, Boolean/0-1 und null/leer gelten als gleich', () => {
  assert.equal(snapshotKey({ a: 1500, b: true, c: null }), snapshotKey({ a: '1500', b: 1, c: '' }));
  assert.equal(snapshotKey({ b: 1, a: 2 }), snapshotKey({ a: 2, b: 1 }));
  assert.notEqual(snapshotKey({ a: 1 }), snapshotKey({ a: 2 }));
  assert.notEqual(snapshotKey({ list: ['x'] }), snapshotKey({ list: [] }));
});

test('frisch geladen ist nichts ungespeichert; eine Änderung macht genau ihren Pfad ungespeichert', () => {
  const { card } = fakeCard();
  assert.equal(card.bookSettingsDirty(), false);
  card.pub = { description: 'neu' };
  assert.deepEqual(card._dirtyKeys(), ['publication']);
  assert.equal(card.headerDisabled(), false);
});

test('ein nicht geladener Pfad gilt nie als ungespeichert (kein Speichern ungeladener Defaults)', () => {
  const { card } = fakeCard();
  card.bookPublicationLoaded = false;
  card.pub = { description: 'neu' };
  assert.equal(card._isDirty('publication'), false);
});

test('Speichern schreibt nur geänderte Pfade, mit der Buch-ID des Formulars', async () => {
  const { card, saved } = fakeCard();
  card.pub = { description: 'neu' };
  await card.saveActiveTab();
  assert.deepEqual(saved, [['publication', '7']]);
  assert.equal(card.bookSettingsDirty(), false);
});

test('fehlender Buchtyp sperrt nur den Pfad «settings», der Rest wird gespeichert und der Reiter springt', async () => {
  const { card, saved } = fakeCard({ bookSettingsBuchtyp: '' });
  card.form = { title: 'B', isbn: '' };
  card.pub = { description: 'neu' };
  const ok = await card._saveDirty('7', { jump: true });
  assert.equal(ok, false);
  assert.deepEqual(saved, [['publication', '7']]);
  assert.equal(card.bookSettingsError, 'book.settings.buchtypRequired');
  assert.equal(card.bookSettingsTab, 'book');
});

test('_settleSave: wer während des Speicherns weitertippt, behält den Stand als ungespeichert', () => {
  const { card } = fakeCard();
  card.pub = { description: 'gesendet' };
  const sent = card._snapKey('publication');
  card.pub = { description: 'gesendet + mehr' };
  let applied = false;
  card._settleSave('publication', sent, () => { applied = true; });
  assert.equal(applied, false, 'Antwort darf das Weitergetippte nicht überschreiben');
  assert.equal(card._isDirty('publication'), true);
});

test('Buch-Bindung: Antworten für ein anderes Buch gehören nicht ins Formular', () => {
  const { card } = fakeCard();
  assert.equal(card._isFormBook('7'), true);
  assert.equal(card._isFormBook(7), true);
  assert.equal(card._isFormBook('8'), false);
  card._formBookId = '8';
  assert.equal(card._isFormBook('8'), false, 'gewähltes Buch ist 7 — Formular von 8 ist veraltet');
});

test('jede SAVE_PATHS-Methode existiert in den Bucheinstellungs-Modulen', () => {
  const dir = join(REPO, 'public/js/book/book-settings');
  const src = readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
  for (const p of SAVE_PATHS) {
    for (const name of [p.save, p.snapshot].filter(Boolean)) {
      assert.match(src, new RegExp(`\\b${name}\\(`), `${p.key}: ${name} fehlt`);
    }
  }
  const card = readFileSync(join(REPO, 'public/js/cards/book-settings-card.js'), 'utf8');
  for (const p of SAVE_PATHS) {
    for (const field of [p.saving, p.saved, p.error, p.loaded, p.dirty].filter(Boolean)) {
      assert.match(card, new RegExp(`\\b${field}:`), `${p.key}: State-Feld ${field} nicht deklariert`);
    }
  }
});

test('resolveDailyGoal: NULL = Default, 0 = kein Ziel, Zahl = Ziel', () => {
  assert.equal(resolveDailyGoal(null), DEFAULT_DAILY_GOAL_CHARS);
  assert.equal(resolveDailyGoal(undefined), DEFAULT_DAILY_GOAL_CHARS);
  assert.equal(resolveDailyGoal(0), 0);
  assert.equal(resolveDailyGoal('0'), 0);
  assert.equal(resolveDailyGoal(2400), 2400);
});
