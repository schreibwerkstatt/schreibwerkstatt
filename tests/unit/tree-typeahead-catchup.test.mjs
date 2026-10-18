// Seitenbaum: Typeahead-Regel (tree/keyboard.js#typeaheadTarget) und welche
// Schaetzwerte der leise Nachzug verwirft (tree/catchup.js#_staleTokEstIds).
// Beide sind reine Regeln — der gerenderte Baum ist in
// tests/e2e-app/tree-filter-mode.spec.js abgedeckt.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { typeaheadTarget } from '../../public/js/book/tree/keyboard.js';
import { treeCatchUpMethods } from '../../public/js/book/tree/catchup.js';

const labels = ['kapitel 1', 'anfang', 'kapitel 2', 'abend', 'kälte'];

test('typeahead: ein Buchstabe springt ab dem naechsten Eintrag, zyklisch', () => {
  assert.equal(typeaheadTarget(labels, 0, 'k'), 2);
  assert.equal(typeaheadTarget(labels, 2, 'k'), 4);
  assert.equal(typeaheadTarget(labels, 4, 'k'), 0, 'nach dem letzten Treffer zurueck an den Anfang');
  assert.equal(typeaheadTarget(labels, 1, 'a'), 3);
});

test('typeahead: laengeres Praefix prueft den aktuellen Eintrag mit', () => {
  assert.equal(typeaheadTarget(labels, 2, 'kap'), 2);
  assert.equal(typeaheadTarget(labels, 0, 'kä'), 4);
});

test('typeahead: kein Treffer / leere Eingabe → -1', () => {
  assert.equal(typeaheadTarget(labels, 0, 'z'), -1);
  assert.equal(typeaheadTarget(labels, 0, ''), -1);
  assert.equal(typeaheadTarget([], 0, 'a'), -1);
});

test('_staleTokEstIds: nur Seiten mit Schaetzwert und geaendertem updated_at', () => {
  const host = {
    tokEsts: { 1: { chars: 10 }, 2: { chars: 20 }, 3: { chars: 30 } },
    $store: { nav: { pages: [
      { id: 1, updated_at: '2026-10-18T08:00:00Z' }, // unveraendert
      { id: 2, updated_at: '2026-10-18T09:00:00Z' }, // anderswo bearbeitet
      { id: 3, updated_at: '2026-10-18T09:00:00Z' }, // neu im Baum
      { id: 4, updated_at: '2026-10-18T09:00:00Z' }, // ohne Schaetzwert
    ] } },
  };
  const before = new Map([[1, '2026-10-18T08:00:00Z'], [2, '2026-10-18T08:00:00Z'], [4, '2026-10-18T08:00:00Z']]);
  assert.deepEqual(treeCatchUpMethods._staleTokEstIds.call(host, before), [2]);
});
