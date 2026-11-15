import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergePasses, TYP_PRIORITY, _prio } = require('../../lib/lektorat-consolidate.js');

const TEXT = 'Er gieng wegen dem Regen nach Hause. Sie war müde, und ging schlafen. Der Fernseher lief.';

function f(typ, original, korrektur = '', erklaerung = '') {
  return { typ, original, korrektur, erklaerung };
}

test('mergePasses: Duplikate und überlappende Funde innerhalb eines Passes werden einer', () => {
  const out = mergePasses([[
    f('rechtschreibung', 'gieng', 'ging'),
    f('rechtschreibung', 'gieng', 'ging'),
    f('grammatik', 'wegen dem', 'wegen des'),
    f('grammatik', 'wegen dem Regen', 'wegen des Regens'),
  ]], TEXT);
  assert.deepEqual(out.map(x => x.original), ['gieng', 'wegen dem']);
});

test('mergePasses: Ausgabe nach Textposition, nicht-lokalisierte gleich normalisiert = ein Fund', () => {
  const out = mergePasses([
    [f('grammatik', 'und ging', ', und ging'), f('grammatik', 'Wegen  dem  Sturm', 'wegen des Sturms')],
    [f('rechtschreibung', 'gieng', 'ging'), f('grammatik', 'wegen dem sturm', 'wegen des Sturms')],
  ], TEXT);
  assert.equal(out.length, 3);
  assert.equal(out[0].original, 'gieng', 'früher im Text zuerst');
  assert.equal(out[1].original, 'und ging');
});

test('mergePasses: überlappende Funde aus zwei Pässen → spezifischster Typ gewinnt', () => {
  const objektiv = [f('grammatik', 'wegen dem Regen', 'wegen des Regens')];
  const stil = [f('stil', 'wegen dem Regen nach Hause', 'nach dem Regen heim')]; // überlappt
  const out = mergePasses([objektiv, stil], TEXT);
  assert.equal(out.length, 1, 'überlappend → ein Eintrag');
  assert.equal(out[0].typ, 'grammatik', 'grammatik hat Vorrang vor stil');
});

test('mergePasses: nicht-überlappende Funde bleiben beide erhalten', () => {
  const objektiv = [f('rechtschreibung', 'gieng', 'ging')];
  const stil = [f('stil', 'Der Fernseher lief.', 'Der Fernseher flimmerte.')];
  const out = mergePasses([objektiv, stil], TEXT);
  assert.equal(out.length, 2);
});

// Kette A–B–C: A überlappt B, B überlappt C, A und C liegen auseinander. Die
// Kette ist kein Fund — A und C sind zwei, und B gehört zu dem, den es überlappt.
test('mergePasses: transitive Kette verschluckt das ferne Kettenende nicht', () => {
  const objektiv = [f('rechtschreibung', 'gieng', 'ging'), f('grammatik', 'nach Hause. Sie', 'nach Hause, sie')];
  const stil = [f('stil', 'gieng wegen dem Regen nach Hause', 'ging im Regen heim')];
  const out = mergePasses([objektiv, stil], TEXT);
  assert.deepEqual(out.map(x => x.original), ['gieng', 'nach Hause. Sie']);
});

test('Typ-Priorität: dialogformat < rechtschreibung < grammatik < stil (spezifisch zuerst)', () => {
  assert.ok(_prio('dialogformat') < _prio('rechtschreibung'));
  assert.ok(_prio('rechtschreibung') < _prio('grammatik'));
  assert.ok(_prio('grammatik') < _prio('stil'));
  assert.ok(_prio('unbekannt') >= TYP_PRIORITY.length, 'unbekannter Typ ganz hinten');
});
