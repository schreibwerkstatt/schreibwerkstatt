// Schrittweise gerenderte Listen (public/js/list-window.js): Fenstergrösse,
// Einblenden einer Zielzeile hinter dem Fenster, ein Fenster je Gruppe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIST_WINDOW_STEP, listWindowSizeFor, listWindowState, listWindowMethods,
} from '../../public/js/list-window.js';

const card = (step) => ({ ...listWindowState(step), ...listWindowMethods });
const range = (n) => Array.from({ length: n }, (_, i) => i);

test('Fenster zeigt die ersten STEP Zeilen, Rest zählt den Überhang', () => {
  const c = card();
  const list = range(LIST_WINDOW_STEP + 7);
  assert.equal(c.listWindowed(list).length, LIST_WINDOW_STEP);
  assert.equal(c.listWindowRest(list), 7);
  c.listWindowMore();
  assert.equal(c.listWindowed(list).length, list.length);
  assert.equal(c.listWindowRest(list), 0);
});

test('kurze Liste kommt unverändert zurück (gleiche Referenz)', () => {
  const c = card();
  const list = range(3);
  assert.equal(c.listWindowed(list), list);
  assert.equal(c.listWindowed(null).length, 0);
});

test('Reveal erweitert auf ganze Schritte bis zur Zielzeile, nie zurück', () => {
  assert.equal(listWindowSizeFor(10, 150, 150), 150);
  assert.equal(listWindowSizeFor(150, 150, 150), 300);
  assert.equal(listWindowSizeFor(964, 150, 150), 1050);
  assert.equal(listWindowSizeFor(-1, 300, 150), 300);
  const c = card();
  c.listWindowReveal(964);
  assert.equal(c.listWindowSize(), 1050);
  c.listWindowReveal(5);
  assert.equal(c.listWindowSize(), 1050);
});

test('gruppierte Liste: ein Fenster je Schlüssel, eigene Schrittweite', () => {
  const c = card(40);
  const a = range(100);
  const b = range(100);
  c.listWindowMore('a');
  assert.equal(c.listWindowed(a, 'a').length, 80);
  assert.equal(c.listWindowed(b, 'b').length, 40);
  assert.equal(c.listWindowRest(b, 'b'), 60);
});

test('Fenster wird neu zugewiesen, nie in place — ein resetState-Literal bleibt leer', () => {
  const reset = listWindowState();
  const c = { ...reset, ...listWindowMethods };
  c.listWindowMore();
  c.listWindowReveal(900, 'x');
  assert.deepEqual(reset.listWindowSizes, {});
  Object.assign(c, reset);
  assert.equal(c.listWindowSize(), LIST_WINDOW_STEP);
  assert.equal(c.listWindowSize('x'), LIST_WINDOW_STEP);
});
