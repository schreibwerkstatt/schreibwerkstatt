// Indikation «Lohnt sich ein Lauf?» im Start-Modal der Komplettanalyse — reine
// Rechenlogik aus lib/komplett-delta.js. Gegated, was die Empfehlung trägt:
// Umstellungen zählen nicht als Änderung, Satzanfänge und bekannte Wörter liefern
// keine „neuen Namen", und die Schwellen ordnen die Stufen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  textDelta, novelNames, catalogWordSet, affectedFigures, komplettVerdict,
} = require('../../lib/komplett-delta.js');

test('textDelta: Umstellung von Sätzen ist keine Änderung', () => {
  const d = textDelta('Anna geht. Ben bleibt.', 'Ben bleibt. Anna geht.');
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
});

test('textDelta: Umformulierung zählt hinzu und weg', () => {
  const d = textDelta('Anna geht. Ben bleibt.', 'Anna geht. Ben rennt davon.');
  assert.deepEqual(d.addedSentences, ['Ben rennt davon.']);
  assert.equal(d.added, 'Ben rennt davon.'.length);
  assert.equal(d.removed, 'Ben bleibt.'.length);
});

test('novelNames: nur wiederholt, nicht am Satzanfang, nicht bekannt', () => {
  const added = [
    'Dann kam Kowalski herein.', 'Sie sah Kowalski an.',
    'Später rief Anna.', 'Er traf Anna wieder.',
    'Morgen ging sie.', 'Er sah Ludmila einmal.',
  ];
  const known = catalogWordSet({ figuren: [{ name: 'Anna Berg', aliases: [] }], orte: [] });
  const names = novelNames(added, known);
  assert.deepEqual(names, [{ name: 'Kowalski', count: 2 }]);
});

test('affectedFigures: Bestandteil eines Namens oder Alias reicht, ausgemusterte nicht', () => {
  const figuren = [
    { id: 1, name: 'Anna Berg', kurzname: 'Anna', aliases: [] },
    { id: 2, name: 'Bernhard Huber', aliases: ['der Alte'] },
    { id: 3, name: 'Clara Stein', aliases: [], stale: 1 },
  ];
  const r = affectedFigures(['Dann kam Huber.', 'Clara lachte.'], figuren);
  assert.deepEqual(r.list, [{ id: 2, name: 'Bernhard Huber' }]);
});

test('komplettVerdict: Stufen', () => {
  const base = { hasRun: true, totalChars: 100000, newPages: 0, deletedPages: 0, novelNameCount: 0 };
  assert.equal(komplettVerdict({ hasRun: false }).level, 'never');
  assert.equal(komplettVerdict({ ...base, changedChars: 0 }).level, 'skip');
  assert.equal(komplettVerdict({ ...base, changedChars: 500 }).level, 'low');
  assert.equal(komplettVerdict({ ...base, changedChars: 3000 }).level, 'optional');
  assert.equal(komplettVerdict({ ...base, changedChars: 500, novelNameCount: 1 }).level, 'optional');
  assert.equal(komplettVerdict({ ...base, changedChars: 0, deletedPages: 1 }).level, 'optional');
  assert.equal(komplettVerdict({ ...base, changedChars: 12000 }).level, 'recommended');
  assert.equal(komplettVerdict({ ...base, changedChars: 500, novelNameCount: 3 }).level, 'recommended');
});
