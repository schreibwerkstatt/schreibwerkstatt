// Kapitelnummern der Auswertungs-Labels (public/js/chapter-filter.js#buildKapitelNumbers)
// und ihr Einsatz als Spaltenkopf der Figuren-Präsenz (figuren-presence.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKapitelNumbers, numberedKapitelLabel } from '../../public/js/chapter-filter.js';

globalThis.window = globalThis.window || {};
const { computePresence } = await import('../../public/js/book/figuren-presence.js');

test('Nummern über den ganzen Baum: Ober- und Unterkapitel, ausgeschlossene zählen, Solo nicht', () => {
  const tree = [
    { type: 'chapter', id: 'solo-9', solo: true },
    { type: 'chapter', id: 1, name: 'Vorwort' },
    { type: 'chapter', id: 2, name: 'Teil I' },
    { type: 'chapter', id: 21, name: 'A', parent_id: 2 },
    { type: 'chapter', id: 211, name: 'A1', parent_id: 21 },
    { type: 'chapter', id: 22, name: 'B', parent_id: 2, excluded: true },
    { type: 'chapter', id: 3, name: 'Teil II', excluded: true },
    { type: 'chapter', id: 31, name: 'C', parent_id: 3 },
  ];
  const nums = buildKapitelNumbers(tree);
  assert.deepEqual([...nums.entries()], [
    [1, '1'], [2, '2'], [21, '2.1'], [211, '2.1.1'], [22, '2.2'], [3, '3'], [31, '3.1'],
  ]);
});

test('Label: Nummer vor dem Namen, ohne Nummer der Name', () => {
  assert.equal(numberedKapitelLabel('12', "I'd finally book that dance class."), "12 · I'd finally book that dance class.");
  assert.equal(numberedKapitelLabel('', 'Prolog'), 'Prolog');
  assert.equal(numberedKapitelLabel('3', ''), '3');
});

test('Präsenz: Spaltenköpfe sind die Kapitelnummern, Kapitel ohne Auftritt bleiben Spalten', () => {
  const axis = [
    { value: 1, label: '1 · Disclaimer', num: '1' },
    { value: 2, label: '2 · Prologue', num: '2' },
    { value: 3, label: '3 · Gym', num: '3' },
  ];
  const fig = { id: 7, name: 'Ada', typ: 'hauptfigur', kapitel: [{ chapter_id: 3, haeufigkeit: 2 }] };
  const data = computePresence([fig], axis);
  assert.deepEqual(data.chapterNums, ['1', '2', '3']);
  assert.equal(data.chapters.length, 3);
  assert.deepEqual(data.rows[0].haeByCol, [0, 0, 2]);
});
