// Unit-Test fuer lib/languagetool-chunk.js: Absatz-Segmente, Packen zu
// Upstream-Anfragen, Rueckverteilung der Treffer auf die Segmente.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { splitSegments, packSegments, assignMatches, CHUNK_MAX } = require('../../lib/languagetool-chunk.js');

test('splitSegments: leer -> []', () => {
  assert.deepEqual(splitSegments(''), []);
  assert.deepEqual(splitSegments(null), []);
});

test('splitSegments: ein Segment pro Absatz, Offsets absolut, Leerabsaetze fallen weg', () => {
  const text = 'Eins.\n\nZwei.\n\n\n   \n\nDrei.';
  const segs = splitSegments(text);
  assert.deepEqual(segs.map(s => s.text), ['Eins.', 'Zwei.', 'Drei.']);
  for (const s of segs) assert.equal(text.slice(s.offset, s.offset + s.text.length), s.text);
});

test('splitSegments: einfacher Zeilenumbruch trennt nicht', () => {
  assert.deepEqual(splitSegments('Zeile eins\nZeile zwei').map(s => s.text), ['Zeile eins\nZeile zwei']);
});

test('splitSegments: Absatz > max wird an Satzgrenzen geteilt, notfalls hart', () => {
  const sentence = 'a'.repeat(9_000) + '. ';
  const para = sentence.repeat(10);
  const segs = splitSegments(para, 20_000);
  assert.ok(segs.length > 1);
  for (const s of segs) {
    assert.ok(s.text.length <= 20_000);
    assert.equal(para.slice(s.offset, s.offset + s.text.length), s.text);
  }
  const huge = 'b'.repeat(70_000);
  const hs = splitSegments(huge, CHUNK_MAX);
  assert.ok(hs.length >= 2);
  assert.equal(hs.map(s => s.text).join(''), huge);
});

test('packSegments: verbindet mit \\n\\n und haelt max ein', () => {
  const segs = [{ text: 'a'.repeat(30) }, { text: 'b'.repeat(30) }, { text: 'c'.repeat(30) }];
  const batches = packSegments(segs, 70);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].text, 'a'.repeat(30) + '\n\n' + 'b'.repeat(30));
  assert.deepEqual(batches[0].parts, [{ index: 0, offset: 0, length: 30 }, { index: 1, offset: 32, length: 30 }]);
  assert.deepEqual(batches[1].parts, [{ index: 2, offset: 0, length: 30 }]);
});

test('packSegments: ein Segment > max bekommt eine eigene Anfrage', () => {
  const batches = packSegments([{ text: 'x'.repeat(10) }, { text: 'y'.repeat(100) }], 50);
  assert.equal(batches.length, 2);
  assert.equal(batches[1].text.length, 100);
});

test('assignMatches: Offsets relativ zum Segment, grenzueberschreitende Treffer fallen weg', () => {
  const batch = packSegments([{ text: 'Hallo Welt' }, { text: 'Zweiter Satz' }])[0];
  const out = assignMatches(batch, [
    { offset: 6, length: 4, rule: { id: 'A' } },           // „Welt" in Segment 0
    { offset: 12 + 8, length: 4, rule: { id: 'B' } },      // „Satz" in Segment 1
    { offset: 8, length: 8, rule: { id: 'C' } },           // reicht ueber den Trenner
  ]);
  assert.deepEqual(out.get(0).map(m => [m.rule.id, m.offset]), [['A', 6]]);
  assert.deepEqual(out.get(1).map(m => [m.rule.id, m.offset]), [['B', 8]]);
});

test('assignMatches: Segment ohne Treffer bekommt leeres Array (cachebar)', () => {
  const batch = packSegments([{ text: 'eins' }, { text: 'zwei' }])[0];
  const out = assignMatches(batch, []);
  assert.deepEqual([...out.entries()], [[0, []], [1, []]]);
});
