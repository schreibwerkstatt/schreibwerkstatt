// Positions-Anker der Übernahmen im Notebook-Edit-Modus
// (public/js/editor/lektorat/anchors.js): Strg+Z ist erkannt, wenn an der
// Stelle der Übernahme wieder das Original steht — auch wenn dieselbe
// Korrektur anderswo im Abschnitt vorkommt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorState, shiftAnchors, shiftAnchorsByEdits, correctionDelta } from '../../public/js/editor/lektorat/anchors.js';

const f = (original, korrektur) => ({ original, korrektur });

test('Strg+Z erkannt, obwohl die Korrektur anderswo steht', () => {
  const e = { f: f('das er kommt', 'dass er kommt'), at: 30 };
  const applied = 'Ich weiss, dass er kommt, und dass er kommt.';
  assert.equal(applied.indexOf('dass er kommt', 12), 30);
  assert.equal(anchorState(applied, e), 'applied');
  const undone = 'Ich weiss, dass er kommt, und das er kommt.';
  assert.equal(anchorState(undone, e), 'undone');
});

test('längere Form zuerst: Komma eingefügt und Komma gestrichen', () => {
  const add = { f: f('sagte er', 'sagte er,'), at: 0 };
  assert.equal(anchorState('sagte er, dann ging er', add), 'applied');
  assert.equal(anchorState('sagte er dann ging er', add), 'undone');
  const drop = { f: f('sagte er,', 'sagte er'), at: 0 };
  assert.equal(anchorState('sagte er dann ging er', drop), 'applied');
  assert.equal(anchorState('sagte er, dann ging er', drop), 'undone');
});

test('umgeschrieben → lost, ohne Anker → null', () => {
  assert.equal(anchorState('ganz anderer Text', { f: f('a b', 'a c'), at: 0 }), 'lost');
  assert.equal(anchorState('a c', { f: f('a b', 'a c'), at: -1 }), null);
});

test('Anfuehrungszeichen gefaltet wie im Index-Text', () => {
  const e = { f: f('„Ja“, sagte', '«Ja», sagte'), at: 0 };
  assert.equal(anchorState('"Ja", sagte sie', e), 'applied');
});

test('shiftAnchors: davor bleibt, dahinter verschiebt, im Bereich bleibt stehen', () => {
  const before = { at: 0 };
  const after = { at: 20 };
  const inside = { at: 6 };
  const none = { at: -1 };
  // «fg» → «QQQQ»: geändert ist [5, 7) im alten Text, +2 Zeichen.
  shiftAnchors('abcdefghij0123456789xyz', 'abcdeQQQQhij0123456789xyz', [before, after, inside, none]);
  assert.equal(before.at, 0);
  assert.equal(after.at, 22);
  assert.equal(inside.at, 6);
  assert.equal(none.at, -1);
});

test('shiftAnchorsByEdits: nur Ersetzungen vor dem Anker zählen', () => {
  const e = { at: 50 };
  shiftAnchorsByEdits([{ at: 10, len: 3, delta: 1 }, { at: 60, len: 2, delta: -1 }, { at: 30, len: 4, delta: 2 }], [e]);
  assert.equal(e.at, 53);
});

test('correctionDelta rechnet in der Normalform', () => {
  assert.equal(correctionDelta(f('das  er', 'dass er')), 1);
});
