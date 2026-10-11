// Unit-Test fuer lib/languagetool-filter.js (pure, kein DB-Zugriff): Woerterbuch,
// Buchnamen, abgeschaltete Regeln.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { filterMatches, buildNameSet } = require('../../lib/languagetool-filter.js');
const { buildDictionary } = require('../../lib/dictionary-forms.js');

function mk(word, { rule = 'GERMAN_SPELLER_RULE', cat = 'TYPOS' } = {}) {
  return {
    offset: 4, length: word.length,
    rule: { id: rule, category: { id: cat } },
    context: { text: `Das ${word} ist seltsam.`, offset: 4, length: word.length },
  };
}
const words = (ms) => ms.map(m => m.context.text.substr(m.context.offset, m.context.length));

test('ohne Filterquellen: unveraendert', () => {
  const ms = [mk('Foo')];
  assert.deepEqual(filterMatches(ms, {}), ms);
  assert.deepEqual(filterMatches(ms), ms);
});

test('Woerterbuch: case-insensitive, auch fuer Nicht-Rechtschreib-Treffer', () => {
  const ms = [mk('Hugo'), mk('Otto'), mk('hugo', { rule: 'DE_CASE', cat: 'CASING' })];
  assert.deepEqual(words(filterMatches(ms, { dict: buildDictionary(['hugo']) })), ['Otto']);
});

test('Buchnamen: Einzelwoerter, Kurzname, Genitiv — nur gegen Rechtschreib-Treffer', () => {
  const names = buildNameSet(['Anna-Lena Brest', 'Hans', '  ', '«Die Au»']);
  assert.deepEqual([...names].sort(), ['anna-lena', 'au', 'brest', 'die', 'hans']);
  const ms = [mk('Anna-Lenas'), mk('Brest'), mk('Hans\''), mk('Hansi'), mk('Brest', { rule: 'DE_AGREEMENT', cat: 'GRAMMAR' })];
  assert.deepEqual(words(filterMatches(ms, { names })), ['Hansi', 'Brest']);
});

test('abgeschaltete Regeln', () => {
  const ms = [mk('Foo'), mk('Bar', { rule: 'WHITESPACE_RULE', cat: 'TYPOGRAPHY' })];
  assert.deepEqual(words(filterMatches(ms, { rules: new Set(['WHITESPACE_RULE']) })), ['Foo']);
});

test('Treffer ohne context bleibt stehen', () => {
  const ms = [{ rule: { id: 'X' } }];
  assert.deepEqual(filterMatches(ms, { dict: buildDictionary(['foo']) }), ms);
});

test('Woerterbuch-Genitiv: nur fuer grossgeschriebene Eintraege (Nomen)', () => {
  const dict = buildDictionary(['Riggenbach', 'Säliwald', 'Niklaus', 'schnachte']);
  const ms = [mk('Riggenbachs'), mk('Säliwaldes'), mk('Niklaus\''), mk('schnachtes'), mk('Riggenbachn')];
  assert.deepEqual(words(filterMatches(ms, { dict })), ['schnachtes', 'Riggenbachn']);
});
