// Wort-Diff der Seiten-Chat-Vorschlagskarten (public/js/diff/word-diff.js) und
// Auswahl der Inline-Marken (public/js/chat/page-chat-marks.js#computeChatMarks).
import test from 'node:test';
import assert from 'node:assert/strict';
import { wordDiff, tokenize } from '../../public/js/diff/word-diff.js';
import { computeChatMarks } from '../../public/js/chat/page-chat-marks.js';

const join = (parts, types) => parts.filter(p => types.includes(p.t)).map(p => p.v).join('');

test('tokenize: Wörter, Whitespace und Satzzeichen getrennt; Bindestrich eigenes Token, Apostroph im Wort', () => {
  assert.deepEqual(tokenize('Haus-Tür, offen.'), ['Haus', '-', 'Tür', ',', ' ', 'offen', '.']);
  assert.deepEqual(tokenize("geht's"), ["geht's"]);
  assert.deepEqual(tokenize(''), []);
});

test('wordDiff: im Kompositum wird nur der geänderte Teil markiert', () => {
  assert.deepEqual(wordDiff('Das E-Mail-Postfach', 'Das Mail-Postfach'),
    [{ t: 'eq', v: 'Das ' }, { t: 'del', v: 'E-' }, { t: 'eq', v: 'Mail-Postfach' }]);
  assert.deepEqual(wordDiff('der Fenster-Rahmen', 'der Tür-Rahmen'),
    [{ t: 'eq', v: 'der ' }, { t: 'del', v: 'Fenster' }, { t: 'add', v: 'Tür' }, { t: 'eq', v: '-Rahmen' }]);
});

test('wordDiff: komplett ersetztes Kompositum bleibt eine Marke', () => {
  assert.deepEqual(wordDiff('die Ost-West Achse', 'die Nord-Süd Achse'),
    [{ t: 'eq', v: 'die ' }, { t: 'del', v: 'Ost-West' }, { t: 'add', v: 'Nord-Süd' }, { t: 'eq', v: ' Achse' }]);
  // Gedankenstrich-Bindestrich zwischen Wörtern bleibt Gleichtext.
  const d = wordDiff('alt - neu', 'kalt - teuer');
  assert.ok(d.some(p => p.t === 'eq' && p.v.includes('-')), JSON.stringify(d));
});

test('wordDiff: Kompositum-Fälle rekonstruieren beide Seiten exakt', () => {
  for (const [a, b] of [['Ost-West-Achse', 'Nord-Süd-Achse'], ['A-B', 'C-D-E'], ['Haus-Tür', 'Haustür'], ['x-y z', 'p-q r']]) {
    const d = wordDiff(a, b);
    assert.equal(join(d, ['eq', 'del']), a);
    assert.equal(join(d, ['eq', 'add']), b);
  }
});

test('wordDiff: rekonstruiert beide Seiten exakt', () => {
  const a = 'Er ging langsam nach Hause, müde.';
  const b = 'Er schlich nach Hause. Müde.';
  const d = wordDiff(a, b);
  assert.equal(join(d, ['eq', 'del']), a);
  assert.equal(join(d, ['eq', 'add']), b);
});

test('wordDiff: Satzzeichen-Änderung bleibt klein, Wörter bleiben Gleichtext', () => {
  const d = wordDiff('Der Hund bellt,', 'Der Hund bellt.');
  assert.deepEqual(d, [{ t: 'eq', v: 'Der Hund bellt' }, { t: 'del', v: ',' }, { t: 'add', v: '.' }]);
});

test('wordDiff: identisch → nur Gleichtext; leer → Einfügung', () => {
  assert.deepEqual(wordDiff('gleich', 'gleich'), [{ t: 'eq', v: 'gleich' }]);
  assert.deepEqual(wordDiff('', 'neu'), [{ t: 'add', v: 'neu' }]);
});

test('wordDiff: zu gross für die Tabelle → null (Aufrufer zeigt zwei Blöcke)', () => {
  const big = 'wort '.repeat(400);
  assert.equal(wordDiff(big, big + 'x'), null);
});

test('computeChatMarks: nur offene Vorschläge der letzten Assistant-Nachricht', () => {
  const msgs = [
    { role: 'assistant', vorschlaege: [{ original: 'alt', ersatz: 'neu' }] },
    { role: 'user', content: 'weiter' },
    { role: 'assistant', vorschlaege: [
      { original: 'a', ersatz: 'b' },
      { original: 'c', ersatz: 'd', _applied: true },
      { original: 'e', ersatz: 'f', _discarded: true },
      { original: 'g', ersatz: 'h', _stale: true },
      { original: 'i', ersatz: 'j' },
      // Mehrdeutig: die Marke sässe an der ersten Fundstelle, nicht zwingend der gemeinten.
      { original: 'k', ersatz: 'l', _ambiguous: true },
    ] },
  ];
  assert.deepEqual(computeChatMarks(msgs), [
    { msgIdx: 2, vIdx: 0, original: 'a', ersatz: 'b' },
    { msgIdx: 2, vIdx: 4, original: 'i', ersatz: 'j' },
  ]);
  assert.deepEqual(computeChatMarks([{ role: 'user', content: 'x' }]), []);
  assert.deepEqual(computeChatMarks(null), []);
});
