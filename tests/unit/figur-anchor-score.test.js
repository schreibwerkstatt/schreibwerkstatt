'use strict';
// Figuren-Verankerung: die Konfidenz ist der rohe Cosinus (`semScore`), nicht der
// Rang-/Rerank-Wert `score`. Bei Hybrid-Retrieval (Default) liegt `score` als RRF
// bei ~0.03 — gegen den Default-Floor 0.35 fiele sonst JEDER Treffer heraus und der
// Ist-Index würde leer ersetzt.

const test = require('node:test');
const assert = require('node:assert/strict');
const { _occsFromHits } = require('../../routes/jobs/figur-anchor');

test('Hybrid-Treffer: RRF-score klein, semScore hoch → Fund bleibt, gespeichert wird semScore', () => {
  const occ = _occsFromHits([
    { kind: 'page', entity_id: 11, text: '<p>Sie glaubt, nur Leistung zählt.</p>', score: 0.0328, semScore: 0.71 },
  ], 0.35);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].score, 0.71);
  assert.equal(occ[0].pageId, 11);
  assert.equal(occ[0].snippet, 'Sie glaubt, nur Leistung zählt.');
});

test('Reine FTS-Kandidaten (semScore null) und Treffer unter dem Floor fallen weg', () => {
  const occ = _occsFromHits([
    { kind: 'page', entity_id: 1, text: 'a', score: 0.03, semScore: null },
    { kind: 'scene', entity_id: 2, text: 'b', score: 0.9, semScore: 0.2 },
    { kind: 'scene', entity_id: 3, text: 'c', score: 0.01, semScore: 0.5 },
  ], 0.35);
  assert.deepEqual(occ.map(o => [o.kind, o.sceneId, o.score]), [['scene', 3, 0.5]]);
});

test('Dedup pro (kind, entity): der erste (bestplatzierte) Treffer gewinnt', () => {
  const occ = _occsFromHits([
    { kind: 'page', entity_id: 5, text: 'x', semScore: 0.6 },
    { kind: 'page', entity_id: 5, text: 'y', semScore: 0.9 },
  ], 0);
  assert.equal(occ.length, 1);
  assert.equal(occ[0].snippet, 'x');
});
