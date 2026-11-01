// Tests für palette-fuzzy: Ranking-Regressionen in der Command-Palette.
// Hintergrund: greedy left-to-right Match wählte q[0] an der ersten Stelle —
// auch wenn eine spätere Position (Word-Boundary, lange Consecutive-Kette)
// klar besseren Score ergäbe. Beispiel: q="chat" gegen "Buch-Chat" picked
// `c` aus "Buch" statt aus "Chat" und verlor gegen Treffer in Description-
// Strings ("Charakterkarte" als Desc von "Figuren").
import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyMatch } from '../../public/js/cards/palette-fuzzy.js';

test('fuzzyMatch: leere Query liefert Score 0', () => {
  const r = fuzzyMatch('', 'irgendwas');
  assert.equal(r.score, 0);
  assert.deepEqual(r.indices, []);
});

test('fuzzyMatch: kein Match → null', () => {
  assert.equal(fuzzyMatch('xyz', 'abc'), null);
});

test('fuzzyMatch: bevorzugt späteren Word-Boundary-Start vor früherem Mid-Word', () => {
  // q="chat": "Buch-Chat" muss mit Indizes [5,6,7,8] (im "Chat") matchen,
  // nicht mit [2,3,7,8] (c aus "Buch", h aus "Buch", dann a/t aus "Chat").
  const r = fuzzyMatch('chat', 'Buch-Chat');
  assert.ok(r);
  assert.deepEqual(r.indices, [5, 6, 7, 8]);
});

test('fuzzyMatch: "chat" rankt Buch-Chat-Label vor Charakterkarte-Desc', () => {
  // Reproduziert das Bug-Szenario aus der Palette: Label-Treffer "Buch-Chat"
  // muss klar besser scoren als Subsequence-Treffer in "Charakterkarte".
  const buchChat = fuzzyMatch('chat', 'Buch-Chat');
  const charKarte = fuzzyMatch('chat', 'Charakterkarte');
  assert.ok(buchChat && charKarte);
  assert.ok(
    buchChat.score < charKarte.score,
    `Buch-Chat (${buchChat.score}) muss < Charakterkarte (${charKarte.score}) sein`,
  );
});

test('fuzzyMatch: Diakritika werden ignoriert (Schauplätze)', () => {
  const r = fuzzyMatch('schau', 'Schauplätze');
  assert.ok(r);
  assert.deepEqual(r.indices, [0, 1, 2, 3, 4]);
});

test('fuzzyMatch: Indizes zeigen auf den Original-String, auch wenn normalize die Länge ändert', async () => {
  const { highlight } = await import('../../public/js/cards/palette-fuzzy.js');
  // Zerlegter Umlaut (NFD, z. B. aus macOS-Dateinamen): "A" + U+0308.
  const nfd = 'Ärger';
  const r = fuzzyMatch('rg', nfd);
  assert.deepEqual(r.indices, [2, 3]);
  // Treffer auf dem Grundbuchstaben nimmt den Akzent mit ins <mark>.
  assert.equal(highlight(nfd, fuzzyMatch('ar', nfd).indices), '<mark class="palette-mark">Är</mark>ger');
  // 'İ'.toLowerCase() ergibt zwei Zeichen.
  assert.deepEqual(fuzzyMatch('ok', 'İstanbul ok').indices, [9, 10]);
});
