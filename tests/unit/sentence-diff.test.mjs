// Satzweise Lesbarkeit des Wort-Diffs — geteilt von allen Diff-Ansichten im
// Lesefluss (Chat-/Profil-Vorschläge, Inline-Historie, Review-Vorschläge).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readableParts, sentenceRewritten, sentenceUnits } from '../../public/js/diff/sentence-diff.js';
import { wordDiff } from '../../public/js/diff/word-diff.js';
import { diffParts } from '../../public/js/diff/diff-parts.js';

const side = (parts, keep) => parts.filter(p => p.t === 'eq' || p.t === keep).map(p => p.v).join('');

test('ein ersetztes Wort bleibt Wort-Diff, auch im Kurzsatz', () => {
  const d = diffParts('Er kam.', 'Er lief.');
  assert.deepEqual(d.filter(p => p.t === 'del').map(p => p.v), ['kam']);
  assert.deepEqual(d.filter(p => p.t === 'add').map(p => p.v), ['lief']);
});

test('umgeschriebener Satz: alt ganz gestrichen, neu ganz eingefügt', () => {
  const d = diffParts('Er lag auf dem Rücken, die Augen offen.', 'Rücklings lag er da, mit offenen Augen.');
  assert.deepEqual(d.filter(p => p.t === 'del').map(p => p.v), ['Er lag auf dem Rücken, die Augen offen.']);
  assert.deepEqual(d.filter(p => p.t === 'add').map(p => p.v), ['Rücklings lag er da, mit offenen Augen.']);
});

test('nur der umgeschriebene Satz wird Block, der Nachbar bleibt Wort-Diff', () => {
  const a = 'Er lag auf dem Rücken, die Augen offen. Die Finger waren nicht sauber.';
  const b = 'Rücklings lag er da, mit offenen Augen. Die dicken Finger waren nicht sauber.';
  const parts = readableParts(wordDiff(a, b));
  assert.deepEqual(parts.filter(p => p.t === 'add').map(p => p.v.trim()),
    ['Rücklings lag er da, mit offenen Augen.', 'dicken']);
});

test('beide Seiten bleiben rekonstruierbar (bis auf das Trenn-Leerzeichen im Block)', () => {
  const a = 'Der Hund bellt laut. Er lag auf dem Rücken, die Augen offen. Ende.';
  const b = 'Der Hund bellt leise. Rücklings lag er da, mit offenen Augen. Ende.';
  const parts = readableParts(wordDiff(a, b));
  assert.equal(side(parts, 'del').replace(/\s+/g, ' '), a);
  assert.equal(side(parts, 'add').replace(/\s+/g, ' ').trim(), b.replace(/\s+/g, ' '));
});

test('Schwelle: mehr als ein Drittel und mindestens drei geänderte Wörter', () => {
  const unit = (a, b) => sentenceUnits(wordDiff(a, b))[0];
  assert.equal(sentenceRewritten(unit('Die Finger waren nicht sauber.', 'Die dicken Finger waren nicht sauber.')), false);
  assert.equal(sentenceRewritten(unit('bellt laut', 'kläfft leise')), true);
  assert.equal(sentenceRewritten(unit('Der Hund bellt laut im Hof.', 'Der Hund bellt leise im Hof.')), false);
});

test('null (Text zu gross) bleibt null', () => {
  assert.equal(readableParts(null), null);
});
