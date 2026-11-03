// Beziehungsprüfung in der Figuren-Karte (public/js/book/figuren-relcheck.js):
// eine Kante wird markiert, wenn ein Konflikt sie über `relation:<id>` als
// Quelle nennt — mit allen Regeln, ohne Dubletten; Ereignis-/Biografie-Quellen
// markieren keine Kante.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRelConflictIndex } from '../../public/js/book/figuren-relcheck.js';

test('Kante trägt die Regeln aller Konflikte, die sie als Quelle nennen', () => {
  const idx = computeRelConflictIndex({
    conflicts: [
      { rule: 'maxParents', sources: ['relation:1', 'relation:2'] },
      { rule: 'generationGap', sources: ['relation:1'] },
      { rule: 'textContradiction', sources: ['event:9', 'relation:1'] },
      { rule: 'textContradiction', sources: ['bio:fig_1.hintergrund'] },
    ],
    edges: [
      { id: 1, from: 'fig_1', to: 'fig_3', typ: 'elternteil' },
      { id: 2, from: 'fig_1', to: 'fig_2', typ: 'elternteil' },
    ],
  });
  assert.deepEqual(idx.get('fig_1|fig_3|elternteil'), ['maxParents', 'generationGap', 'textContradiction']);
  assert.deepEqual(idx.get('fig_1|fig_2|elternteil'), ['maxParents']);
  assert.equal(idx.size, 2);
});

test('ohne Prüfergebnis: leerer Index', () => {
  assert.equal(computeRelConflictIndex(null).size, 0);
  assert.equal(computeRelConflictIndex({ conflicts: [], edges: [] }).size, 0);
});
