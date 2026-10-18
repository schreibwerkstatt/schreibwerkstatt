// Geteilter Diff-Kern (public/js/diff/): Markierung (diff-parts.js) und
// Text-Extraktion (html-blocks.js) — dieselben für Abschnitts-Historie,
// Fassungen, Kommentar-Leisten, Konflikt-Auflösung und Chat-Vorschläge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { markParts, wordParts, diffParts, partsToHtml } from '../../public/js/diff/diff-parts.js';
import { parseBlocks, blockText } from '../../public/js/diff/html-blocks.js';

const P = (t, v) => ({ t, v });

test('markParts: Seiten filtern vor dem Markieren — Rand-Whitespace einer Löschung bleibt links', () => {
  const parts = [P('eq', 'Er '), P('del', 'ging '), P('add', 'lief '), P('eq', 'heim')];
  assert.deepEqual(markParts(parts, 'old'), [
    { t: 'eq', v: 'Er ', c: '' },
    { t: 'del', v: 'ging', c: 'diff-del' },
    { t: 'eq', v: ' heim', c: '' },
  ]);
  assert.deepEqual(markParts(parts, 'new').map(p => p.v).join(''), 'Er lief heim');
  assert.deepEqual(markParts(parts, 'both').map(p => p.t), ['eq', 'del', 'eq', 'add', 'eq']);
});

test('markParts: reine Satzzeichen tragen diff-mark--punct, Wörter nicht', () => {
  const m = markParts([P('del', '"'), P('add', '«'), P('del', 'Haus')]);
  assert.deepEqual(m.map(p => p.c), ['diff-del diff-mark--punct', 'diff-add diff-mark--punct', 'diff-del']);
});

test('markParts: null bleibt null (Text zu gross für wordDiff)', () => {
  assert.equal(markParts(null), null);
});

test('diffParts: Chat-Vorschlag als markierte Teile, beide Seiten rekonstruierbar', () => {
  const d = diffParts('Der Hund bellt laut.', 'Der Hund bellt leise.');
  assert.equal(d.filter(p => p.t !== 'add').map(p => p.v).join(''), 'Der Hund bellt laut.');
  assert.equal(d.filter(p => p.t !== 'del').map(p => p.v).join(''), 'Der Hund bellt leise.');
  assert.deepEqual(d.filter(p => p.t !== 'eq').map(p => [p.c, p.v]), [['diff-del', 'laut'], ['diff-add', 'leise']]);
});

test('wordParts: jsdiff springt nur ein, wenn wordDiff zu gross ist', () => {
  const lib = { diffWords: () => [{ value: 'x', removed: true }, { value: 'y', added: true }] };
  assert.deepEqual(wordParts('a b', 'a c', lib), [P('eq', 'a '), P('del', 'b'), P('add', 'c')]);
  const big = 'w '.repeat(600);
  assert.deepEqual(wordParts(big, big + 'z', lib), [P('del', 'x'), P('add', 'y')]);
  assert.equal(wordParts(big, big + 'z'), null);
});

test('partsToHtml: escaped, del/ins mit Klasse, Gleichtext optional als span', () => {
  const parts = markParts([P('eq', '<a> '), P('del', 'b&c')]);
  assert.equal(partsToHtml(parts), '&lt;a&gt; <del class="diff-del">b&amp;c</del>');
  assert.equal(partsToHtml(parts, 'diff-eq'), '<span class="diff-eq">&lt;a&gt; </span><del class="diff-del">b&amp;c</del>');
});

test('parseBlocks: <br> trennt, Inline-Markup klebt nicht auseinander', () => {
  assert.deepEqual(parseBlocks('<p>Zeile eins<br>Zeile <b>zwei</b>.</p>'), [{ tag: 'p', text: 'Zeile eins Zeile zwei.' }]);
});

test('blockText: Listen und Umbrüche auf eigenen Zeilen, Entities dekodiert', () => {
  assert.equal(blockText('<ul><li>Eins</li><li>Zwei &amp; drei</li></ul>'), 'Eins\nZwei & drei');
  assert.equal(blockText('<blockquote><p>A</p><p>B<br>C</p></blockquote>'), 'A\nB\nC');
  assert.equal(blockText(null), '');
});
