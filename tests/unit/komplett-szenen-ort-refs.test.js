'use strict';
// Szene ↔ Schauplatz per Kennung (routes/jobs/komplett/szenen-ort-refs.js): das Modell
// verweist auf orte[].id derselben Antwort bzw. auf die bek_N-Liste eines Gap-Passes; der
// Server trägt den exakten Ortsnamen ein. Dazu die Einreihung nachgezogener Szenen.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  answerOrtRefMap, knownOrtRefs, resolveSzenenOrtRefs, anchorGapSzenen, placeGapSzenen,
} = require('../../routes/jobs/komplett/szenen-ort-refs');

test('Kennung aus derselben Antwort wird zum exakten Ortsnamen — auch bei gleichnamigen Räumen', () => {
  const orte = [
    { id: 'ort_1', name: 'Küche der WG' },
    { id: 'ort_2', name: 'Küche in Toms Wohnung' },
  ];
  const szenen = [{ titel: 'Krisensitzung', orte_refs: ['ort_1'] }, { titel: 'Abendessen', orte_refs: ['ORT_2 '] }];
  const dropped = resolveSzenenOrtRefs(szenen, answerOrtRefMap(orte));
  assert.equal(dropped, 0);
  assert.deepEqual(szenen.map(s => s.orte_namen), [['Küche der WG'], ['Küche in Toms Wohnung']]);
  assert.ok(szenen.every(s => !('orte_refs' in s)), 'orte_refs fällt weg, damit Cache und Remap nur Namen sehen');
});

test('Gap-Szene: bek_N aus der Liste, unbekannte Kennung verworfen, Klarname bleibt als Rettungsweg', () => {
  const known = knownOrtRefs([{ name: 'Bad der WG' }, 'Toms Wohnung', { name: 'bad der wg' }]);
  assert.deepEqual(known.lines, ['bek_1: Bad der WG', 'bek_2: Toms Wohnung']);
  const szenen = [{ titel: 'x', orte_refs: ['bek_2', 'bek_9', 'ort_4', 'Möbelhaus'], orte_namen: ['Toms Wohnung'] }];
  const dropped = resolveSzenenOrtRefs(szenen, known.map);
  assert.equal(dropped, 2);
  assert.deepEqual(szenen[0].orte_namen, ['Toms Wohnung', 'Möbelhaus']);
});

test('Nachgezogene Szenen landen hinter ihrem Anker, nicht am Kapitelende', () => {
  const a = { titel: 'A', kapitel: 'K1' }, b = { titel: 'B', kapitel: 'K1' }, c = { titel: 'C', kapitel: 'K2' };
  const x = { titel: 'x', kapitel: 'K1', nach: 1 };
  const y = { titel: 'y', kapitel: 'K1', nach: 1 };   // gleicher Anker: Reihenfolge bleibt
  const z = { titel: 'z', kapitel: 'K2', nach: 0 };   // Kapitelanfang
  const w = { titel: 'w', kapitel: 'K1' };            // ohne Anker: Ende des Kapitels
  const v = { titel: 'v', kapitel: 'K1', nach: 3 };   // Anker in anderem Kapitel: Ende des Kapitels
  const fresh = [x, y, z, w, v];
  anchorGapSzenen(fresh, [a, b, c, ...fresh]);
  assert.equal(x.nach_titel, 'A');
  assert.equal(z.nach_start, true);
  const target = placeGapSzenen([a, b, c], fresh);
  assert.deepEqual(target.map(s => s.titel), ['A', 'x', 'y', 'B', 'w', 'v', 'z', 'C']);
  assert.ok(target.every(s => !('nach' in s) && !('nach_titel' in s) && !('nach_start' in s)));
});

test('Titel-Anker überlebt den Cache: andere Liste im Folgelauf, gleiche Einreihung', () => {
  const x = { titel: 'x', kapitel: 'K1', nach: 2 };
  anchorGapSzenen([x], [{ titel: 'A', kapitel: 'K1' }, { titel: 'B', kapitel: 'K1' }]);
  const cached = JSON.parse(JSON.stringify(x));
  const target = [{ titel: 'Neu', kapitel: 'K1' }, { titel: 'A', kapitel: 'K1' }, { titel: 'B', kapitel: 'K1' }, { titel: 'C', kapitel: 'K1' }];
  placeGapSzenen(target, [cached]);
  assert.deepEqual(target.map(s => s.titel), ['Neu', 'A', 'B', 'x', 'C']);
});
