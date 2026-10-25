import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenSnapshot, diffSnapshots, diffChapters, diffPublication } from '../../public/js/book-snapshot-diff.js';

function page(srcId, name, html) { return { type: 'page', srcId, name, html }; }
function chapter(name, children) { return { type: 'chapter', name, children }; }
function chap(srcId, name, children, excluded) { return { type: 'chapter', srcId, name, children, excluded }; }

test('flattenSnapshot: liest Tree-Format und Node-Array, mit Kapitelpfad', () => {
  const tree = [
    page(1, 'Vorwort', '<p>a</p>'),
    chapter('Kap 1', [page(2, 'S1', '<p>b</p>'), chapter('Unterkapitel', [page(3, 'S2', '<p>c</p>')])]),
  ];
  const fromTree = flattenSnapshot({ book: {}, tree });
  const fromArr = flattenSnapshot(tree);
  assert.deepEqual(fromTree, fromArr);
  assert.equal(fromTree.length, 3);
  assert.deepEqual(fromTree[0].chapterPath, []);
  assert.deepEqual(fromTree[1].chapterPath, ['Kap 1']);
  assert.deepEqual(fromTree[2].chapterPath, ['Kap 1', 'Unterkapitel']);
});

test('diffSnapshots: erkennt added/removed/changed/unchanged', () => {
  const from = [page(1, 'A', '<p>hallo</p>'), page(2, 'B', '<p>welt</p>')];
  const to   = [page(1, 'A', '<p>hallo</p>'), page(3, 'C', '<p>neu</p>')];
  const { summary, entries } = diffSnapshots(from, to);
  assert.equal(summary.added, 1);     // C
  assert.equal(summary.removed, 1);   // B
  assert.equal(summary.unchanged, 1); // A
  assert.equal(summary.changed, 0);
  const byStatus = Object.fromEntries(entries.map(e => [e.srcId, e.status]));
  assert.equal(byStatus[1], 'unchanged');
  assert.equal(byStatus[3], 'added');
  assert.equal(byStatus[2], 'removed');
});

test('diffSnapshots: Textänderung zählt als changed (HTML-Markup ignoriert)', () => {
  const from = [page(1, 'A', '<p>der hund</p>')];
  const to   = [page(1, 'A', '<p><strong>der hund</strong></p>')]; // gleicher Text, anderes Markup
  const a = diffSnapshots(from, to);
  assert.equal(a.summary.unchanged, 1, 'reines Markup ändert den Text nicht');

  const to2 = [page(1, 'A', '<p>die katze</p>')];
  const b = diffSnapshots(from, to2);
  assert.equal(b.summary.changed, 1);
  assert.equal(b.entries[0].status, 'changed');
});

test('diffSnapshots: rename + move Flags', () => {
  const from = [chapter('Alt', [page(1, 'Titel', '<p>x</p>')])];
  const to   = [chapter('Neu', [page(1, 'Titel neu', '<p>x</p>')])];
  const { summary, entries } = diffSnapshots(from, to);
  assert.equal(summary.renamed, 1);
  assert.equal(summary.moved, 1);
  const e = entries.find(x => x.srcId === 1);
  assert.equal(e.renamed, true);
  assert.equal(e.oldName, 'Titel');
  assert.equal(e.moved, true);
  assert.deepEqual(e.oldChapterPath, ['Alt']);
  assert.deepEqual(e.chapterPath, ['Neu']);
});

test('diffSnapshots: charsFrom/charsTo aus Plain-Text', () => {
  const from = [page(1, 'A', '<p>abc</p>')];
  const to   = [page(1, 'A', '<p>abcdef</p>')];
  const { summary } = diffSnapshots(from, to);
  assert.equal(summary.charsFrom, 3);
  assert.equal(summary.charsTo, 6);
});

test('diffPublication: nur geänderte Textfelder, in Feld-Reihenfolge', () => {
  const from = { author_name: 'Kafka', isbn: '111', subtitle: 'Alt' };
  const to   = { author_name: 'Kafka', isbn: '222', subtitle: '' };
  const diff = diffPublication(from, to);
  assert.deepEqual(diff.map(d => d.key), ['isbn', 'subtitle']);
  assert.deepEqual(diff[0], { key: 'isbn', kind: 'text', from: '111', to: '222' });
  assert.equal(diff[1].to, '');
});

test('diffPublication: Whitespace/null-Normalisierung → keine Scheinänderung', () => {
  const diff = diffPublication({ isbn: ' 123 ' }, { isbn: '123', subtitle: null });
  assert.equal(diff.length, 0);
});

test('diffPublication: Cover/Autorfoto als bool (vorhanden ja/nein)', () => {
  const diff = diffPublication({ has_cover: false, has_author_image: true }, { has_cover: true, has_author_image: true });
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0], { key: 'has_cover', kind: 'bool', from: false, to: true });
});

test('diffPublication: null-Meta → gegen leer verglichen, kein Crash', () => {
  assert.deepEqual(diffPublication(null, null), []);
  const diff = diffPublication(null, { isbn: '999', has_cover: true });
  assert.equal(diff.find(d => d.key === 'isbn').to, '999');
  assert.equal(diff.find(d => d.key === 'has_cover').to, true);
});

test('diffSnapshots: Kapitel umbenannt (gleiche srcId) → Abschnitte NICHT verschoben', () => {
  const from = [chap(10, 'Alt', [page(1, 'S', '<p>x</p>'), page(2, 'T', '<p>y</p>')])];
  const to   = [chap(10, 'Neu', [page(1, 'S', '<p>x</p>'), page(2, 'T', '<p>y</p>')])];
  const { summary, chapters } = diffSnapshots(from, to);
  assert.equal(summary.moved, 0);
  assert.equal(summary.chaptersChanged, 1);
  assert.equal(chapters[0].renamed, true);
  assert.equal(chapters[0].oldName, 'Alt');
});

test('diffSnapshots: Abschnitt in anderes Kapitel → verschoben', () => {
  const from = [chap(10, 'A', [page(1, 'S', '<p>x</p>')]), chap(11, 'B', [])];
  const to   = [chap(10, 'A', []), chap(11, 'B', [page(1, 'S', '<p>x</p>')])];
  const e = diffSnapshots(from, to).entries.find(x => x.srcId === 1);
  assert.equal(e.moved, true);
  assert.deepEqual(e.oldChapterPath, ['A']);
});

test('diffSnapshots: Umsortieren markiert nur den bewegten Abschnitt', () => {
  const from = [chap(10, 'A', [page(1, 'a', '<p>1</p>'), page(2, 'b', '<p>2</p>'), page(3, 'c', '<p>3</p>'), page(4, 'd', '<p>4</p>')])];
  const to   = [chap(10, 'A', [page(2, 'b', '<p>2</p>'), page(3, 'c', '<p>3</p>'), page(4, 'd', '<p>4</p>'), page(1, 'a', '<p>1</p>')])];
  const { summary, entries } = diffSnapshots(from, to);
  assert.equal(summary.reordered, 1);
  assert.equal(entries.find(x => x.srcId === 1).reordered, true);
});

test('diffChapters: neu, entfernt, Export-Ausschluss umgeschaltet', () => {
  const from = [chap(10, 'A', []), chap(11, 'B', [])];
  const to   = [chap(10, 'A', [], true), chap(12, 'C', [])];
  const out = diffChapters(from, to);
  const by = Object.fromEntries(out.map(c => [c.srcId, c]));
  assert.equal(by[10].status, 'changed');
  assert.equal(by[10].excludedChanged, true);
  assert.equal(by[10].excluded, true);
  assert.equal(by[12].status, 'added');
  assert.equal(by[11].status, 'removed');
});

test('diffPublication: ausgetauschtes Cover (gleiches Vorhandensein, anderer Hash)', () => {
  const diff = diffPublication({ has_cover: true, cover_hash: 'aaa' }, { has_cover: true, cover_hash: 'bbb' });
  assert.deepEqual(diff, [{ key: 'has_cover', kind: 'replaced', from: true, to: true }]);
  assert.deepEqual(diffPublication({ has_cover: true, cover_hash: 'aaa' }, { has_cover: true }), [], 'fehlender Hash ist kein Austausch');
});
