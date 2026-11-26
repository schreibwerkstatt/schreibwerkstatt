// Änderungsvorschlag (Review-Link) als Wort-Diff, gekürzt auf die geänderten
// Sätze — eine Darstellung für Share-Reader, Notebook-Leseansicht und Bucheditor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestionDiffParts } from '../../public/js/diff/suggestion-diff.js';

const text = parts => parts.map(p => p.v).join('');
const marks = (parts, t) => parts.filter(p => p.t === t).map(p => p.v);

test('ein eingefügtes Wort im langen Absatz: nur der geänderte Satz, Rest als «…»', () => {
  const alt = 'von weitem und wusste es bereits, bevor ich näher kam. Er lag auf dem Rücken. '
    + 'Doch ich kannte ihn. Die Finger waren nicht sauber. Jemand hatte sie gründlich gewaschen';
  const neu = alt.replace('Die Finger', 'Die dicken Finger');
  const parts = suggestionDiffParts(alt, neu);
  assert.equal(text(parts), '… Die dicken Finger waren nicht sauber. …');
  assert.deepEqual(marks(parts, 'add'), ['dicken']);
  assert.deepEqual(marks(parts, 'del'), []);
});

test('Änderungen in zwei Sätzen mit unverändertem dazwischen: beide Sätze, «…» dazwischen', () => {
  const alt = 'Er kam. Es regnete. Sie ging.';
  const neu = 'Er lief. Es regnete. Sie rannte.';
  const parts = suggestionDiffParts(alt, neu);
  assert.equal(text(parts), 'Er kamlief. … Sie gingrannte.');
  assert.deepEqual(marks(parts, 'del'), ['kam', 'ging']);
  assert.deepEqual(marks(parts, 'add'), ['lief', 'rannte']);
});

test('Satzende als Änderung: die betroffenen Sätze bleiben zusammen', () => {
  const parts = suggestionDiffParts('Er kam. Sie ging. Ende.', 'Er kam, sie ging. Ende.');
  assert.equal(text(parts), 'Er kam., Siesie ging. …');
});

test('kurze Stelle ohne Satzgrenze, ganz ersetzt: alt → neu als Block, keine Auslassung', () => {
  const parts = suggestionDiffParts('bellt laut', 'kläfft leise');
  assert.equal(text(parts).includes('…'), false);
  assert.deepEqual(marks(parts, 'del'), ['bellt laut']);
  assert.deepEqual(marks(parts, 'add'), ['kläfft leise']);
});

test('umgeschriebener Satz als Block, wenig geänderter als Wort-Diff, Rest «…»', () => {
  const alt = 'Er lag auf dem Rücken, die Augen offen. Doch ich kannte ihn. Die Finger waren nicht sauber.';
  const neu = 'Rücklings lag er da, mit offenen Augen. Doch ich kannte ihn. Die dicken Finger waren nicht sauber.';
  const parts = suggestionDiffParts(alt, neu);
  assert.deepEqual(marks(parts, 'del'), ['Er lag auf dem Rücken, die Augen offen.']);
  assert.deepEqual(marks(parts, 'add'), ['Rücklings lag er da, mit offenen Augen.', 'dicken']);
  assert.equal(text(parts),
    'Er lag auf dem Rücken, die Augen offen. Rücklings lag er da, mit offenen Augen. … Die dicken Finger waren nicht sauber.');
});

test('Markierungsklassen aus diff-parts (diff-add/diff-del)', () => {
  const parts = suggestionDiffParts('Er kam.', 'Er lief.');
  assert.ok(parts.some(p => p.t === 'add' && p.c === 'diff-add'));
  assert.ok(parts.some(p => p.t === 'del' && p.c === 'diff-del'));
});
