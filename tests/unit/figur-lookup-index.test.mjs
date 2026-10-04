// Figuren-Lookup im Editor (Ctrl/Cmd-Klick auf einen Namen): der Index
// normalisierter Name → Figur. Gesichert werden die drei Regeln, an denen der
// Lookup sonst falsch trifft:
//   - Namenspartikel („von", „der") sind kein Einzel-Treffer.
//   - Stale Figuren (nicht mehr im Text) stehen nicht im Index.
//   - Ein Token, das zwei Figuren teilen, ist mehrdeutig (null), aber Vollname,
//     Kurzname und Token DERSELBEN Figur machen sie nicht mehrdeutig.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFigurLookupIndex } from '../../public/js/editor/figur-lookup.js';

test('Namenspartikel sind kein Einzel-Treffer, der Vollname schon', () => {
  const goethe = { id: 'fig_1', name: 'Johann von Goethe' };
  const idx = buildFigurLookupIndex([goethe]);
  assert.equal(idx.get('johann von goethe'), goethe);
  assert.equal(idx.get('goethe'), goethe);
  assert.equal(idx.get('johann'), goethe);
  assert.equal(idx.has('von'), false);
});

test('Artikel am Namensanfang wird nicht zum Treffer', () => {
  const alte = { id: 'fig_2', name: 'Der Alte' };
  const idx = buildFigurLookupIndex([alte]);
  assert.equal(idx.has('der'), false);
  assert.equal(idx.get('alte'), alte);
  assert.equal(idx.get('der alte'), alte);
});

test('stale Figuren stehen nicht im Index', () => {
  const idx = buildFigurLookupIndex([
    { id: 'fig_1', name: 'Anna Müller', stale: true },
    { id: 'fig_2', name: 'Bert Huber' },
  ]);
  assert.equal(idx.has('anna muller'), false);
  assert.equal(idx.has('muller'), false);
  assert.equal(idx.get('huber').id, 'fig_2');
});

test('geteiltes Token zweier Figuren ist mehrdeutig, eigene Doppel nicht', () => {
  const anna = { id: 'fig_1', name: 'Anna Müller', kurzname: 'Anna' };
  const hans = { id: 'fig_2', name: 'Hans Müller' };
  const idx = buildFigurLookupIndex([anna, hans]);
  assert.equal(idx.get('muller'), null);
  assert.equal(idx.get('anna'), anna);
  assert.equal(idx.get('hans'), hans);
});

test('leerer/fehlender Katalog liefert einen leeren Index', () => {
  assert.equal(buildFigurLookupIndex(null).size, 0);
  assert.equal(buildFigurLookupIndex([]).size, 0);
});
