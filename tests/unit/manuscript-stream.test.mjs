// Adapter-Tests für das kanonische Manuskript-Stream-Modell. Pure Modul, kein
// DOM — direkt importierbar. Spiegelt die buildBlocksFromPages-Szenarien auf
// Modell-Ebene (fromPages) + deckt fromSnapshotTree/fromGroups ab.

import test from 'node:test';
import assert from 'node:assert/strict';

const { fromPages, fromSnapshotTree, fromGroups } = await import('../../public/js/manuscript-stream.js');

// ── fromPages ────────────────────────────────────────────────────────────────
test('fromPages: leeres/null Input → leeres Array', () => {
  assert.deepEqual(fromPages([]), []);
  assert.deepEqual(fromPages(null), []);
});

test('fromPages: Chapter-Header pro Kapitelwechsel, id===pageId, Kapitel depth 0, Seite depth 1', () => {
  const entries = fromPages([
    { pageId: 1, pageName: 'A', chapterId: 10, chapterName: 'K1', html: '<p>a</p>' },
    { pageId: 2, pageName: 'B', chapterId: 10, chapterName: 'K1', html: '<p>b</p>' },
    { pageId: 3, pageName: 'C', chapterId: 20, chapterName: 'K2', html: '<p>c</p>' },
  ]);
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.map(e => e.kind), ['chapter', 'page', 'page', 'chapter', 'page']);
  assert.equal(entries[0].chapterId, 10);
  assert.equal(entries[0].name, 'K1');
  assert.equal(entries[1].id, 1);
  assert.equal(entries[1].html, '<p>a</p>');
  assert.equal(entries[3].chapterId, 20);
  assert.equal(entries[4].id, 3);
  for (const e of entries) assert.equal(e.depth, e.kind === 'chapter' ? 0 : 1);
});

test('fromPages: Solo-Pages (chapterId null) → kein Header davor', () => {
  const entries = fromPages([
    { pageId: 1, pageName: 'Solo', chapterId: null, html: '<p>x</p>' },
    { pageId: 2, pageName: 'A', chapterId: 10, chapterName: 'K1', html: '<p>a</p>' },
  ]);
  assert.equal(entries[0].kind, 'page');
  assert.equal(entries[0].id, 1);
  assert.equal(entries[0].chapterId, null);
  assert.equal(entries[1].kind, 'chapter');
  assert.equal(entries[2].kind, 'page');
});

test('fromPages: aufeinanderfolgende Pages im selben Kapitel → nur ein Header', () => {
  const entries = fromPages([
    { pageId: 1, chapterId: 10, chapterName: 'K1' },
    { pageId: 2, chapterId: 10, chapterName: 'K1' },
    { pageId: 3, chapterId: 10, chapterName: 'K1' },
  ]);
  const headers = entries.filter(e => e.kind === 'chapter');
  assert.equal(headers.length, 1);
  assert.equal(headers[0].chapterId, 10);
});

// ── fromSnapshotTree ──────────────────────────────────────────────────────────
test('fromSnapshotTree: Nesting → steigende depth, srcId→id, key stabil', () => {
  const tree = [
    { type: 'page', name: 'Solo', html: '<p>s</p>', srcId: 5 },
    { type: 'chapter', name: 'K1', srcId: 70, children: [
      { type: 'page', name: 'A', html: '<p>a</p>', srcId: 1 },
      { type: 'chapter', name: 'K1.1', children: [
        { type: 'page', name: 'B', html: '<p>b</p>', srcId: 2 },
      ] },
    ] },
  ];
  const entries = fromSnapshotTree(tree);
  assert.deepEqual(entries.map(e => e.kind), ['page', 'chapter', 'page', 'chapter', 'page']);
  assert.equal(entries[0].depth, 0);   // Solo-Page
  assert.equal(entries[0].id, 5);
  assert.equal(entries[1].depth, 0);   // K1
  assert.equal(entries[1].chapterId, 70); // srcId → chapterId (Kapitel-Restore)
  assert.equal(entries[3].chapterId, null); // K1.1 ohne srcId
  assert.equal(entries[2].depth, 1);   // A unter K1
  assert.equal(entries[3].depth, 1);   // K1.1
  assert.equal(entries[4].depth, 2);   // B unter K1.1
  assert.deepEqual(entries.map(e => e.key), ['p0', 'c1', 'p2', 'c3', 'p4']);
});

test('fromSnapshotTree: srcId fehlend → id null, Fremd-Nodes übersprungen', () => {
  const entries = fromSnapshotTree([
    { type: 'page', name: 'X' },
    { type: 'note', name: 'ignored' },
    null,
    'garbage',
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, null);
});

test('fromSnapshotTree: kein Array → leer', () => {
  assert.deepEqual(fromSnapshotTree(null), []);
  assert.deepEqual(fromSnapshotTree(undefined), []);
});

// ── fromGroups ────────────────────────────────────────────────────────────────
test('fromGroups: Header pro Gruppe mit chapter, pd.id→id', () => {
  const groups = [
    { chapterId: 10, chapter: { id: 10, name: 'K1' }, pages: [
      { pd: { id: 1, name: 'A', html: '<p>a</p>' } },
      { pd: { id: 2, name: 'B', html: '<p>b</p>' } },
    ] },
    { chapterId: null, chapter: null, pages: [{ pd: { id: 3, name: 'Solo', html: '<p>s</p>' } }] },
  ];
  const entries = fromGroups(groups);
  assert.deepEqual(entries.map(e => e.kind), ['chapter', 'page', 'page', 'page']);
  assert.equal(entries[0].chapterId, 10);
  assert.equal(entries[1].id, 1);
  assert.equal(entries[1].chapterId, 10);
  assert.equal(entries[3].id, 3);          // Solo-Page
  assert.equal(entries[3].chapterId, null);
  assert.deepEqual(entries.map(e => e.depth), [0, 1, 1, 0]);
});

test('fromGroups: leeres/null Input + fehlende pd → robust', () => {
  assert.deepEqual(fromGroups(null), []);
  assert.deepEqual(fromGroups([]), []);
  const entries = fromGroups([{ chapter: null, pages: [{ pd: null }, { pd: { id: 7, name: 'P' } }] }]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 7);
});

// ── Kapitel ohne eigene Abschnitte (Teilbaum) ────────────────────────────────
test('fromPages: Teil ohne eigene Abschnitte bekommt Header, Unterkapitel echte Tiefe', () => {
  const chapters = [
    { id: 1, name: 'Teil I', parentId: null },
    { id: 2, name: 'Kapitel 1', parentId: 1 },
    { id: 3, name: 'Szene 1.1', parentId: 2 },
    { id: 4, name: 'Kapitel 2', parentId: 1 },
    { id: 5, name: 'Teil II', parentId: null },
  ];
  const entries = fromPages([
    { pageId: 1, pageName: 'Vorrede', chapterId: null },
    { pageId: 2, pageName: 'A', chapterId: 2, chapterName: 'Kapitel 1' },
    { pageId: 3, pageName: 'B', chapterId: 3, chapterName: 'Szene 1.1' },
    { pageId: 4, pageName: 'C', chapterId: 4, chapterName: 'Kapitel 2' },
    { pageId: 5, pageName: 'D', chapterId: 5, chapterName: 'Teil II' },
  ], { chapters });
  assert.deepEqual(entries.map(e => [e.kind, e.name, e.depth]), [
    ['page', 'Vorrede', 0],
    ['chapter', 'Teil I', 0],
    ['chapter', 'Kapitel 1', 1],
    ['page', 'A', 2],
    ['chapter', 'Szene 1.1', 2],
    ['page', 'B', 3],
    ['chapter', 'Kapitel 2', 1],
    ['page', 'C', 2],
    ['chapter', 'Teil II', 0],
    ['page', 'D', 1],
  ]);
});

test('fromPages: Rueckkehr ins Elternkapitel nach Unterkapitel → kein zweiter Header', () => {
  const entries = fromPages([
    { pageId: 1, chapterId: 1, chapterName: 'K' },
    { pageId: 2, chapterId: 2, chapterName: 'K.1' },
    { pageId: 3, chapterId: 1, chapterName: 'K' },
  ], { chapters: [{ id: 1, name: 'K', parentId: null }, { id: 2, name: 'K.1', parentId: 1 }] });
  assert.equal(entries.filter(e => e.kind === 'chapter' && e.chapterId === 1).length, 1);
});

test('fromGroups: Ueberschriften-Gruppe (pages: []) + Elternkette → Header mit Tiefe', () => {
  const entries = fromGroups([
    { chapterId: 1, chapter: { id: 1, name: 'Teil I', parent_chapter_id: null }, pages: [] },
    { chapterId: 2, chapter: { id: 2, name: 'Kapitel 1', parent_chapter_id: 1 }, pages: [{ pd: { id: 9, name: 'S', html: '' } }] },
  ]);
  assert.deepEqual(entries.map(e => [e.kind, e.name, e.depth]), [
    ['chapter', 'Teil I', 0], ['chapter', 'Kapitel 1', 1], ['page', 'S', 2],
  ]);
});
