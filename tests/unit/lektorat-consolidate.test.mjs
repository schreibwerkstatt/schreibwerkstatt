import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { consensusFindings, mergePasses, TYP_PRIORITY, _prio } = require('../../lib/lektorat-consolidate.js');

const TEXT = 'Er gieng wegen dem Regen nach Hause. Sie war müde, und ging schlafen. Der Fernseher lief.';

function f(typ, original, korrektur = '', erklaerung = '') {
  return { typ, original, korrektur, erklaerung };
}

test('Konsens ≥2: Fund in 2 von 3 Läufen bleibt, Einzelgänger fällt raus', () => {
  const runs = [
    [f('rechtschreibung', 'gieng', 'ging')],
    [f('rechtschreibung', 'gieng', 'ging')],
    [f('stil', 'Der Fernseher lief.', 'Der Fernseher flimmerte.')], // nur 1 Lauf
  ];
  const out = consensusFindings(runs, TEXT, { threshold: 2 });
  assert.equal(out.length, 1);
  assert.equal(out[0].original, 'gieng');
});

test('Konsens: überlappende Spans mit leicht anderem original zählen als EIN Fund', () => {
  const runs = [
    [f('grammatik', 'wegen dem', 'wegen des')],
    [f('grammatik', 'wegen dem Regen', 'wegen des Regens')],
    [f('grammatik', 'wegen dem', 'wegen des')],
  ];
  const out = consensusFindings(runs, TEXT, { threshold: 2 });
  assert.equal(out.length, 1, 'überlappende Funde → ein Cluster');
  // Repräsentant: häufigste Kombination (2×"wegen dem") gewinnt bei Typ-Gleichstand
  assert.equal(out[0].original, 'wegen dem');
});

test('Konsens: einstimmige Schwelle 3/3 verlangt Übereinstimmung in allen Läufen', () => {
  const runs = [
    [f('rechtschreibung', 'gieng', 'ging')],
    [f('rechtschreibung', 'gieng', 'ging')],
    [f('grammatik', 'wegen dem', 'wegen des')],
  ];
  const out = consensusFindings(runs, TEXT, { threshold: 3 });
  assert.equal(out.length, 0, 'kein Fund in ALLEN 3 → leeres Ergebnis');
});

test('K=1 (lokal): Schwelle wird geklemmt → alle Funde bleiben, aber dedupliziert', () => {
  const runs = [[
    f('rechtschreibung', 'gieng', 'ging'),
    f('rechtschreibung', 'gieng', 'ging'), // exaktes Duplikat
    f('grammatik', 'wegen dem', 'wegen des'),
  ]];
  const out = consensusFindings(runs, TEXT, { threshold: 2 });
  assert.equal(out.length, 2, 'Duplikat entfernt, zwei distinkte Funde bleiben');
});

test('Konsens: nicht-lokalisierte Funde (original nicht im Text) clustern über normalisierte Gleichheit', () => {
  const runs = [
    [f('grammatik', 'Wegen  dem  Sturm', 'wegen des Sturms')], // nicht im TEXT, Whitespace-Variante
    [f('grammatik', 'wegen dem sturm', 'wegen des Sturms')],   // gleiche Normalisierung
  ];
  const out = consensusFindings(runs, TEXT, { threshold: 2 });
  assert.equal(out.length, 1, 'normalisiert gleich → ein Cluster, Konsens erreicht');
});

test('Ausgabe ist nach Textposition sortiert', () => {
  const runs = [
    [f('grammatik', 'und ging', ', und ging'), f('rechtschreibung', 'gieng', 'ging')],
    [f('grammatik', 'und ging', ', und ging'), f('rechtschreibung', 'gieng', 'ging')],
  ];
  const out = consensusFindings(runs, TEXT, { threshold: 2 });
  assert.equal(out.length, 2);
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

test('Konsens: ein Lauf, der nur das andere Kettenende meldet, bestätigt nicht', () => {
  const runs = [
    [f('rechtschreibung', 'gieng', 'ging'), f('stil', 'gieng wegen dem Regen nach Hause', 'ging im Regen heim')],
    [f('grammatik', 'nach Hause. Sie', 'nach Hause, sie')],
  ];
  // gieng (Lauf 0) + Stil-Span (Lauf 0) überlappen; „nach Hause. Sie" (Lauf 1)
  // berührt nur den Stil-Span. Ohne Zerlegung zählte die Kette zwei Läufe.
  const out = consensusFindings(runs, TEXT, { threshold: 2 });
  assert.equal(out.length, 0);
});

test('Typ-Priorität: dialogformat < rechtschreibung < grammatik < stil (spezifisch zuerst)', () => {
  assert.ok(_prio('dialogformat') < _prio('rechtschreibung'));
  assert.ok(_prio('rechtschreibung') < _prio('grammatik'));
  assert.ok(_prio('grammatik') < _prio('stil'));
  assert.ok(_prio('unbekannt') >= TYP_PRIORITY.length, 'unbekannter Typ ganz hinten');
});
