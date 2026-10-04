'use strict';
// Live-Passage zu einem Index-Chunk: Belege/Zitatprüfungen laufen gegen den
// aktuellen Seitentext, der Chunk ist nur Wegweiser.

const test = require('node:test');
const assert = require('node:assert/strict');
const { bestLivePassage } = require('../../lib/live-passage');

const LIVE = 'Erster Absatz ohne Bezug.\n\nAnna war damals zwölf Jahre alt und wohnte am See.\n\nDritter Absatz über das Wetter.';

test('wörtlich enthaltener Chunk → exact, Ausschnitt aus dem Live-Text', () => {
  const r = bestLivePassage(LIVE, 'Anna war damals zwölf Jahre alt', { maxChars: 60 });
  assert.equal(r.exact, true);
  assert.equal(r.overlap, 1);
  assert.match(r.text, /Anna war damals zwölf Jahre alt/);
});

test('leicht umformulierter Chunk → beste aktuelle Stelle, nicht der Chunk-Text', () => {
  const r = bestLivePassage(LIVE, 'Anna war damals elf Jahre alt und wohnte am See', { maxChars: 80 });
  assert.ok(r && !r.exact);
  assert.match(r.text, /zwölf Jahre alt/);
  assert.doesNotMatch(r.text, /elf/);
});

test('Stelle gelöscht/umgeschrieben → null', () => {
  assert.equal(bestLivePassage(LIVE, 'Ganz andere Worte über Maschinen und Fabriken heute'), null);
  assert.equal(bestLivePassage('', 'x'), null);
  assert.equal(bestLivePassage(LIVE, ''), null);
});

test('typografische Anführungszeichen und Zeilenumbrüche stören den Fund nicht', () => {
  const r = bestLivePassage('Er sagte: „Komm\nheim.“ Dann ging er.', 'Er sagte: "Komm heim." Dann', { maxChars: 200 });
  assert.equal(r.exact, true);
});
