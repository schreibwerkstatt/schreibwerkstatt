// Motiv-Werkstatt — Spalten des Kapitel-Verlaufsbands: Hauptkapitel, aufklappbar.
// Zugeklappt zählt ein Kapitel seinen ganzen Teilbaum (wie die Präsenz-Matrix der
// Buchübersicht); aufgeklappt eine eigene Spalte plus die Unterkapitel.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bandMethods } from '../../public/js/book/motiv/band.js';

// nav.tree-Form: flach, depth-first, parent_id.
const TREE = [
  { type: 'chapter', id: 'solo-9', solo: true, depth: 1, parent_id: null, name: 'Vorwort' },
  { type: 'chapter', id: 1, depth: 1, parent_id: null, name: 'Teil 1' },
  { type: 'chapter', id: 11, depth: 2, parent_id: 1, name: '1.1' },
  { type: 'chapter', id: 111, depth: 3, parent_id: 11, name: '1.1.1' },
  { type: 'chapter', id: 12, depth: 2, parent_id: 1, name: '1.2' },
  { type: 'chapter', id: 2, depth: 1, parent_id: null, name: 'Teil 2' },
];
const chapters = TREE.filter(t => !t.solo).map(t => ({ id: t.id, name: t.name, depth: t.depth }));
const cols = (expanded) => bandMethods._computeBandColumns(chapters, TREE, expanded);

test('zugeklappt: nur Hauptkapitel, Teilbaum summiert', () => {
  const c = cols({});
  assert.deepEqual(c.map(x => x.key), ['1+', '2']);
  assert.deepEqual(c[0].ids.sort((a, b) => a - b), [1, 11, 12, 111]);
  assert.equal(c[0].collapsible, true);
  assert.equal(c[1].collapsible, false);
});

test('aufgeklappt: eigene Spalte + Unterkapitel, verschachtelt weiter aufklappbar', () => {
  const c = cols({ 1: true });
  assert.deepEqual(c.map(x => x.key), ['1', '11+', '12', '2']);
  assert.deepEqual(c[0].ids, [1], 'eigene Spalte zählt nur den eigenen Text');
  assert.deepEqual(c[1].ids.sort((a, b) => a - b), [11, 111]);
  assert.deepEqual(cols({ 1: true, 11: true }).map(x => x.key), ['1', '11', '111', '12', '2']);
});

test('Zellzahl = Summe über die Kapitel der Spalte; Detail filtert dieselben Kapitel', () => {
  const motif = { id: 7, name: 'Wasser', occChapters: [{ chapterId: 11, n: 2 }, { chapterId: 111, n: 3 }, { chapterId: 2, n: 1 }] };
  const ctx = {
    ...bandMethods,
    motifs: [motif],
    _memos: {},
    _memo(key, deps, fn) { return fn(); },
    $store: { nav: { tree: TREE } },
    bandExpanded: {},
    bandOccCache: { 7: [{ id: 1, chapter_id: 11 }, { id: 2, chapter_id: 111 }, { id: 3, chapter_id: 2 }] },
    motifById: (id) => (id === 7 ? motif : null),
  };
  const [teil1, teil2] = ctx.bandColumns();
  assert.equal(ctx.bandColCount(7, teil1), 5);
  assert.equal(ctx.bandColCount(7, teil2), 1);
  ctx.activeBandDetailKey = ctx.bandDetailKey(7, teil1);
  const d = ctx._computeBandActiveDetail();
  assert.equal(d.count, 5);
  assert.deepEqual(d.occurrences.map(o => o.id), [1, 2]);
});
