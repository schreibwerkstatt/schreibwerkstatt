import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOrtPresence, computeOrtEncounters } from '../../public/js/book/orte-insights.js';

const CH = [1, 2, 3, 4, 5, 6].map(i => ({ value: i, label: 'K' + i }));
const k = (i, haeufigkeit) => ({ chapter_id: i, name: 'K' + i, ...(haeufigkeit ? { haeufigkeit } : {}) });

test('Präsenz: Häufigkeit je Kapitel, erstes/letztes Vorkommen', () => {
  const p = computeOrtPresence({ kapitel: [k(2, 3), k(4, 1)] }, CH);
  assert.deepEqual(p.haeByCol, [0, 3, 0, 1, 0, 0]);
  assert.equal(p.firstIdx, 1);
  assert.equal(p.lastIdx, 3);
  assert.equal(p.maxCell, 3);
  assert.equal(p.abandoned, false, 'K4 liegt in der zweiten Hälfte');
});

test('Präsenz: nur am Anfang mehrfach Schauplatz → aufgegeben', () => {
  const p = computeOrtPresence({ kapitel: [k(1), k(2)] }, CH);
  assert.equal(p.abandoned, true);
  assert.equal(p.lastChapter, 'K2');
});

test('Präsenz: Einmal-Ort ist nicht aufgegeben, ohne Kapitel → null', () => {
  assert.equal(computeOrtPresence({ kapitel: [k(1)] }, CH).abandoned, false);
  assert.equal(computeOrtPresence({ kapitel: [] }, CH), null);
});

test('Präsenz: gleichnamige Kapitel bleiben getrennte Spalten', () => {
  const dup = [{ value: 1, label: 'Teil I › Einleitung' }, { value: 2, label: 'Teil II › Einleitung' }];
  const p = computeOrtPresence({ kapitel: [{ chapter_id: 2, name: 'Einleitung', haeufigkeit: 2 }] }, dup);
  assert.deepEqual(p.haeByCol, [0, 2]);
});

test('Begegnungen: Paare aus gemeinsamen Szenen am Ort, verwaiste Szenen zählen nicht', () => {
  const szenen = [
    { ort_ids: ['o1'], fig_ids: ['a', 'b'] },
    { ort_ids: ['o1', 'o2'], fig_ids: ['b', 'a', 'c'] },
    { ort_ids: ['o2'], fig_ids: ['a', 'b'] },
    { ort_ids: ['o1'], fig_ids: ['a', 'c'], stale: true },
  ];
  const e = computeOrtEncounters('o1', szenen);
  assert.equal(e.sceneCount, 2);
  assert.deepEqual(e.pairs[0], { a: 'a', b: 'b', scenes: 2 });
  assert.equal(e.pairs.length, 3);
  assert.deepEqual(e.figures.map(f => [f.id, f.scenes]), [['a', 2], ['b', 2], ['c', 1]]);
});
