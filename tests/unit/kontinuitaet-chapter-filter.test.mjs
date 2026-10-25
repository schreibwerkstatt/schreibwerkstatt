// Kontinuitäts-Karte: der Kapitel-Filter leitet das Kapitel eines Befunds aus den
// verankerten Abschnitten (page_a_id/page_b_id) ab — das KI-Feld `kapitel` fehlt oft,
// und die Stelle beginnt mit dem Abschnittsnamen, der ein gleichnamiges Kapitel
// vortäuschen kann. Filterwert ist die Kapitel-ID (chapter-filter.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKapitelLabels, idOptions } from '../../public/js/chapter-filter.js';

const filters = { figurId: '', kapitelId: '', schwere: '', status: '' };
const vater = { type: 'chapter', id: 4, name: 'Der Vater', pages: [] };
const unauff = { type: 'chapter', id: 11, name: 'Der Unauffällige', pages: [] };
const nihil = { type: 'chapter', id: 13, name: 'Der Nihilist', pages: [] };
// Zwei gleichnamige Unterkapitel «Epilog» unter verschiedenen Eltern.
const epilogA = { type: 'chapter', id: 30, name: 'Epilog', parent_id: 4, pages: [] };
const epilogB = { type: 'chapter', id: 31, name: 'Epilog', parent_id: 13, pages: [] };
const tree = [vater, epilogA, unauff, nihil, epilogB];
const pages = [
  { id: 23, name: 'Die erste Beziehung', chapter_id: 4 },
  { id: 24, name: 'Der Vater', chapter_id: 11 },
  { id: 127, name: 'Die Eskalation', chapter_id: 13 },
  { id: 300, name: 'Schluss', chapter_id: 31 },
];
const stores = {
  nav: { tree, pages, selectedBookId: 1 },
  catalog: { figuren: [] },
  catalogUi: { kontinuitaetFilters: filters },
};
globalThis.Alpine = { store: (k) => stores[k] };
globalThis.window = globalThis.window || {};
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
globalThis.window.Alpine = globalThis.Alpine;
const labels = buildKapitelLabels(tree);
const order = new Map(tree.map((c, i) => [c.id, i]));
globalThis.window.__app = {
  $store: stores, t: (k) => k,
  _chapterLabelMap: labels,
  _chapterIdOrderMap: order,
  _kapitelOptionen: (ids) => idOptions(ids, id => labels.get(Number(id)), id => order.get(Number(id)) ?? 9999),
};

const { kontinuitaetMethods } = await import('../../public/js/book/kontinuitaet.js');

const RESULT = {
  issues: [
    // Abschnitt «Der Vater» im Kapitel «Der Unauffällige»; das Modell setzte kapitel falsch.
    { id: 1, page_a_id: 24, page_b_id: 24, stelle_a: 'Der Vater: «x»', kapitel: ['Der Vater'], chapter_ids: [4] },
    { id: 2, page_a_id: 23, page_b_id: 127, stelle_a: 'Die erste Beziehung: «x»', kapitel: [], chapter_ids: [] },
    // Ohne Anker: Kapitelname vor dem Doppelpunkt zählt weiter.
    { id: 3, stelle_a: 'Der Nihilist: «x»', kapitel: [], chapter_ids: [] },
    // Ohne Anker, mehrdeutiger Name: löst nicht auf (kein geratenes Kapitel).
    { id: 4, stelle_a: 'Epilog: «x»', kapitel: ['Epilog'], chapter_ids: [] },
    // Anker im zweiten «Epilog».
    { id: 5, page_a_id: 300, stelle_a: 'Schluss: «x»', kapitel: ['Epilog'], chapter_ids: [] },
  ],
};

function card() {
  return { ...kontinuitaetMethods, _memos: {}, kontinuitaetResult: RESULT };
}
const ids = (c, k) => { filters.kapitelId = k; c._memos = {}; return c.kontinuitaetIssuesSorted().map(i => i.id); };

test('Filter-Auswahl: jedes Kapitel der verankerten Abschnitte, gleichnamige getrennt beschriftet', () => {
  assert.deepEqual(card().kontinuitaetKapitelOptionen(), [
    { value: 4, label: 'Der Vater' },
    { value: 11, label: 'Der Unauffällige' },
    { value: 13, label: 'Der Nihilist' },
    { value: 31, label: 'Der Nihilist › Epilog' },
  ]);
});

test('Kapitel-Filter folgt dem Anker, nicht dem KI-Kapitelnamen', () => {
  const c = card();
  assert.deepEqual(ids(c, 4), [2]);
  assert.deepEqual(ids(c, 11), [1]);
  assert.deepEqual(ids(c, 13), [2, 3]);
  assert.deepEqual(ids(c, 31), [5]);
  filters.kapitelId = '';
});

test('Veralteter Filterwert (Kapitel ohne Befund) filtert nicht still alles weg', () => {
  const c = card();
  assert.deepEqual(ids(c, 30).length, RESULT.issues.length);
  assert.deepEqual(ids(c, 'Der Vater').length, RESULT.issues.length, 'altes Namensformat wirkt nicht');
  filters.kapitelId = '';
});
