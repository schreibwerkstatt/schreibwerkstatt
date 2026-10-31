// Standard-Klappzustand des Seitenbaums (book/tree/build.js): ohne gespeicherten
// State starten Kapitel offen, ab TREE_COLLAPSE_MIN_PAGES Abschnitten zu — ein
// aufgeklapptes Grossbuch rendert sonst jede Abschnittszeile. Ein gespeicherter
// State gewinnt in beiden Faellen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || { dispatchEvent() {}, addEventListener() {} };

const { treeBuildMethods, TREE_COLLAPSE_MIN_PAGES } = await import('../../public/js/book/tree/build.js');

// Zwei Kapitel, die `pageCount` Abschnitte unter sich aufteilen.
function response(pageCount) {
  const pages = Array.from({ length: pageCount }, (_, i) => ({ id: i + 1, name: 'S' + (i + 1), position: i }));
  const half = Math.ceil(pageCount / 2);
  return {
    topPages: [],
    chapters: [
      { id: 1, name: 'A', position: 0, pages: pages.slice(0, half).map(p => ({ ...p, chapter_id: 1 })) },
      { id: 2, name: 'B', position: 1, pages: pages.slice(half).map(p => ({ ...p, chapter_id: 2 })) },
    ],
  };
}

function build(pageCount, openState = {}) {
  const ctx = {
    ...treeBuildMethods,
    $store: { nav: { tree: [], pages: [] } },
    t: (k) => k,
    _loadTreeOpenState: () => openState,
    _rebuildTreeOrderMaps() {},
    _refreshChapterStats() {},
  };
  ctx._buildTreeFromResponse(response(pageCount), 7);
  return Object.fromEntries(ctx.$store.nav.tree.map(it => [it.id, it.open]));
}

test('kleines Buch: Kapitel ohne gespeicherten State starten offen', () => {
  assert.deepEqual(build(TREE_COLLAPSE_MIN_PAGES - 1), { 1: true, 2: true });
});

test('grosses Buch: Kapitel ohne gespeicherten State starten zu', () => {
  assert.deepEqual(build(TREE_COLLAPSE_MIN_PAGES), { 1: false, 2: false });
});

test('gespeicherter State gewinnt in beide Richtungen', () => {
  assert.deepEqual(build(TREE_COLLAPSE_MIN_PAGES, { 1: true }), { 1: true, 2: false });
  assert.deepEqual(build(10, { 2: false }), { 1: true, 2: false });
});
