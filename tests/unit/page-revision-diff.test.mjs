// Tests fuer page-revision-diff: htmlToPlainText-Normalisierung, parseBlocks
// und Side-by-Side-Diff-Rendering. diffLib (diffArrays) wird gemockt, damit der
// Test nicht von jsdiff abhaengt; der Wort-Diff innerhalb eines Absatzes laeuft
// ueber diff/word-diff.js und braucht keinen Mock (diffWords nur als Ausweichweg
// fuer zu grosse Absaetze).
import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToPlainText, parseBlocks, renderSideBySide, renderInline } from '../../public/js/page-revision-diff.js';
// Echtes jsdiff (Server-Dependency) nur fuer die End-zu-End-Faelle unten, deren
// Aussage am Zusammenspiel von Block-Parse und Diff haengt.
import * as Diff from 'diff';

function mockDiffLib({ arrays = [], words = [] } = {}) {
  return {
    diffArrays: () => arrays,
    diffWords: () => words,
  };
}

test('htmlToPlainText: Tags raus, Whitespace gecollapsed', () => {
  assert.equal(htmlToPlainText('<p>Hallo  <em>Welt</em></p>'), 'Hallo Welt');
  assert.equal(htmlToPlainText('<h1>Titel</h1>\n<p>Text</p>'), 'Titel Text');
  assert.equal(htmlToPlainText(null), '');
  assert.equal(htmlToPlainText(''), '');
});

test('parseBlocks: extrahiert p/h*/li/blockquote/pre, ignoriert leere Bloecke', () => {
  const blocks = parseBlocks('<h1>Titel</h1><p>Erster Satz.</p><ul><li>A</li><li>B</li></ul>');
  assert.deepEqual(blocks, [
    { tag: 'h1', text: 'Titel' },
    { tag: 'p', text: 'Erster Satz.' },
    { tag: 'li', text: 'A' },
    { tag: 'li', text: 'B' },
  ]);
});

test('parseBlocks: ohne erkannte Bloecke → Fallback auf einen p-Block', () => {
  assert.deepEqual(parseBlocks('blosser text'), [{ tag: 'p', text: 'blosser text' }]);
  assert.deepEqual(parseBlocks(''), []);
});

test('renderSideBySide: identischer Inhalt → unchanged=true, html leer', () => {
  const lib = mockDiffLib({ arrays: [{ value: ['Hallo Welt'] }] });
  const out = renderSideBySide('<p>Hallo Welt</p>', '<p>Hallo Welt</p>', lib);
  assert.equal(out.unchanged, true);
  assert.equal(out.html, '');
});

test('renderSideBySide: gepaarter Change → zwei Zellen (left=del+eq, right=ins+eq)', () => {
  const lib = mockDiffLib({
    arrays: [
      { value: ['a'], removed: true },
      { value: ['b'], added: true },
    ],
    words: [
      { value: 'Hallo ' },
      { value: 'alte', removed: true },
      { value: 'neue', added: true },
      { value: ' Welt' },
    ],
  });
  const out = renderSideBySide('<p>Hallo alte Welt</p>', '<p>Hallo neue Welt</p>', lib);
  assert.equal(out.unchanged, false);
  // Linke Spalte: del+eq (kein ins)
  assert.match(out.html, /diff-cell--changed diff-cell--left/);
  assert.match(out.html, /<del class="diff-del">alte<\/del>/);
  // Rechte Spalte: ins+eq (kein del)
  assert.match(out.html, /diff-cell--changed diff-cell--right/);
  assert.match(out.html, /<ins class="diff-add">neue<\/ins>/);
  // Inline-eq erscheint auf beiden Seiten
  const eqCount = (out.html.match(/<span class="diff-eq">Hallo <\/span>/g) || []).length;
  assert.equal(eqCount, 2);
});

test('renderSideBySide: fehlende diffLib oder Methoden → wirft', () => {
  assert.throws(() => renderSideBySide('a', 'b', null), /diffLib/);
  assert.throws(() => renderSideBySide('a', 'b', {}), /diffLib/);
  assert.throws(() => renderSideBySide('a', 'b', { diffWords: () => [] }), /diffArrays/);
});

test('renderSideBySide: nur removed → links del, rechts empty', () => {
  const lib = mockDiffLib({ arrays: [{ value: ['alles weg'], removed: true }] });
  const out = renderSideBySide('<p>alles weg</p>', '', lib);
  assert.equal(out.unchanged, false);
  assert.match(out.html, /diff-cell--removed diff-cell--left/);
  assert.match(out.html, /<del class="diff-del">alles weg<\/del>/);
  assert.match(out.html, /diff-cell--empty diff-cell--right/);
});

test('renderSideBySide: nur added → links empty, rechts ins', () => {
  const lib = mockDiffLib({ arrays: [{ value: ['alles neu'], added: true }] });
  const out = renderSideBySide('', '<p>alles neu</p>', lib);
  assert.equal(out.unchanged, false);
  assert.match(out.html, /diff-cell--empty diff-cell--left/);
  assert.match(out.html, /diff-cell--added diff-cell--right/);
  assert.match(out.html, /<ins class="diff-add">alles neu<\/ins>/);
});

test('renderSideBySide: unveraenderter Stretch wird kollabiert mit skipLabel', () => {
  const lib = mockDiffLib({
    arrays: [
      { value: ['eq1', 'eq2'] },
      { value: ['change-old'], removed: true },
      { value: ['change-new'], added: true },
      { value: ['eq3', 'eq4'] },
    ],
    words: [
      { value: 'change-old', removed: true },
      { value: 'change-new', added: true },
    ],
  });
  const oldHtml = '<p>eq1</p><p>eq2</p><p>change-old</p><p>eq3</p><p>eq4</p>';
  const newHtml = '<p>eq1</p><p>eq2</p><p>change-new</p><p>eq3</p><p>eq4</p>';
  const out = renderSideBySide(oldHtml, newHtml, lib, { skipLabel: (n) => `skip:${n}` });
  assert.equal(out.unchanged, false);
  // Trail-/Lead-Context sichtbar
  assert.match(out.html, />eq2</);
  assert.match(out.html, />eq3</);
  // eq1 + eq4 ausserhalb des Context-Fensters
  assert.doesNotMatch(out.html, />eq1</);
  assert.doesNotMatch(out.html, />eq4</);
  assert.match(out.html, /diff-cell--skip/);
  assert.match(out.html, /skip:1/);
});

test('renderSideBySide: Heading-Block behaelt semantisches Tag in beiden Spalten', () => {
  const lib = mockDiffLib({
    arrays: [
      { value: ['Alter Titel'], removed: true },
      { value: ['Neuer Titel'], added: true },
    ],
    words: [
      { value: 'Alter', removed: true },
      { value: 'Neuer', added: true },
      { value: ' Titel' },
    ],
  });
  const out = renderSideBySide('<h1>Alter Titel</h1>', '<h1>Neuer Titel</h1>', lib);
  assert.match(out.html, /<h1 class="diff-cell diff-cell--h1 diff-cell--changed diff-cell--left">/);
  assert.match(out.html, /<h1 class="diff-cell diff-cell--h1 diff-cell--changed diff-cell--right">/);
});

test('renderSideBySide: parseBlocks-Miss → Plain-Text-Fallback rendert Change', () => {
  // Aenderung steckt in <div> (nicht in parseBlocks-BLOCK_TAGS). diffArrays
  // bekommt [] vs [] und meldet unchanged. Fallback muss htmlToPlainText
  // vergleichen und einen Change rendern, sonst Phantom-Rev unsichtbar.
  const lib = mockDiffLib({
    arrays: [],
    words: [
      { value: 'alt', removed: true },
      { value: 'neu', added: true },
    ],
  });
  const out = renderSideBySide('<div>alt</div>', '<div>neu</div>', lib);
  assert.equal(out.unchanged, false);
  assert.match(out.html, /<del class="diff-del">alt<\/del>/);
  assert.match(out.html, /<ins class="diff-add">neu<\/ins>/);
});

test('renderSideBySide: identischer Plain-Text trotz Byte-Diff → unchanged', () => {
  // Sicherheitsnetz, dass Fallback nicht uebersensibel feuert. Beide
  // Bodies normalisieren zu identischem Plain-Text (trailing NBSP-Entity
  // wird via decode + \s+ collapsed entfernt).
  const lib = mockDiffLib({ arrays: [{ value: ['Hallo'] }] });
  const out = renderSideBySide('<p>Hallo</p>', '<p>Hallo&#160;</p>', lib);
  assert.equal(out.unchanged, true);
});

test('renderSideBySide: eq-Block erscheint identisch in beiden Spalten', () => {
  // Anker-Change zwingt eq-Block ins kollabierende Fenster.
  const lib = mockDiffLib({
    arrays: [
      { value: ['eq'] },
      { value: ['old'], removed: true },
      { value: ['new'], added: true },
    ],
    words: [
      { value: 'old', removed: true },
      { value: 'new', added: true },
    ],
  });
  const out = renderSideBySide('<p>eq</p><p>old</p>', '<p>eq</p><p>new</p>', lib);
  const leftEq = (out.html.match(/diff-cell--eq diff-cell--left">eq</g) || []).length;
  const rightEq = (out.html.match(/diff-cell--eq diff-cell--right">eq</g) || []).length;
  assert.equal(leftEq, 1);
  assert.equal(rightEq, 1);
});

// ── renderInline (Lesefluss, eine Spalte) ───────────────────────────────────────

test('renderInline: fehlende diffLib → wirft', () => {
  assert.throws(() => renderInline('a', 'b', null), /diffLib/);
  assert.throws(() => renderInline('a', 'b', { diffWords: () => [] }), /diffArrays/);
});

test('renderInline: identischer Inhalt → unchanged=true, html leer', () => {
  const lib = mockDiffLib({ arrays: [{ value: ['Hallo Welt'] }] });
  const out = renderInline('<p>Hallo Welt</p>', '<p>Hallo Welt</p>', lib);
  assert.equal(out.unchanged, true);
  assert.equal(out.html, '');
});

test('renderInline: gepaarter Change → eine Zeile mit del+ins inline (keine Spalten)', () => {
  const lib = mockDiffLib({
    arrays: [
      { value: ['a'], removed: true },
      { value: ['b'], added: true },
    ],
    words: [
      { value: 'Hallo ' },
      { value: 'alte', removed: true },
      { value: 'neue', added: true },
      { value: ' Welt' },
    ],
  });
  const out = renderInline('<p>Hallo alte Welt</p>', '<p>Hallo neue Welt</p>', lib);
  assert.equal(out.unchanged, false);
  assert.match(out.html, /diff-line--change/);
  assert.match(out.html, /<del class="diff-del">alte<\/del>/);
  assert.match(out.html, /<ins class="diff-add">neue<\/ins>/);
  // Lesefluss: keine Side-by-Side-Zellen, eq-Wort als Plain-Text (kein span).
  assert.doesNotMatch(out.html, /diff-cell--(left|right)/);
  assert.match(out.html, /Hallo /);
});

test('renderInline: nur entfernt → del-Zeile', () => {
  const lib = mockDiffLib({ arrays: [{ value: ['alles weg'], removed: true }] });
  const out = renderInline('<p>alles weg</p>', '', lib);
  assert.equal(out.unchanged, false);
  assert.match(out.html, /diff-line--del/);
  assert.match(out.html, /<del class="diff-del">alles weg<\/del>/);
});

test('renderInline: nur neu → ins-Zeile', () => {
  const lib = mockDiffLib({ arrays: [{ value: ['alles neu'], added: true }] });
  const out = renderInline('', '<p>alles neu</p>', lib);
  assert.equal(out.unchanged, false);
  assert.match(out.html, /diff-line--add/);
  assert.match(out.html, /<ins class="diff-add">alles neu<\/ins>/);
});

test('renderInline: Heading behaelt semantisches Tag', () => {
  const lib = mockDiffLib({
    arrays: [
      { value: ['Alter Titel'], removed: true },
      { value: ['Neuer Titel'], added: true },
    ],
    words: [
      { value: 'Alter', removed: true },
      { value: 'Neuer', added: true },
      { value: ' Titel' },
    ],
  });
  const out = renderInline('<h1>Alter Titel</h1>', '<h1>Neuer Titel</h1>', lib);
  assert.match(out.html, /<h1 class="diff-line diff-line--change">/);
});

test('renderInline: parseBlocks-Miss → Plain-Text-Fallback rendert Change', () => {
  const lib = mockDiffLib({
    arrays: [],
    words: [
      { value: 'alt', removed: true },
      { value: 'neu', added: true },
    ],
  });
  const out = renderInline('<div>alt</div>', '<div>neu</div>', lib);
  assert.equal(out.unchanged, false);
  assert.match(out.html, /<del class="diff-del">alt<\/del>/);
  assert.match(out.html, /<ins class="diff-add">neu<\/ins>/);
});

test('renderSideBySide: Rand-Whitespace ausserhalb der Marke, Satzzeichen als diff-mark--punct', () => {
  const lib = mockDiffLib({ arrays: [{ value: ['x'], removed: true }, { value: ['y'], added: true }] });
  const out = renderSideBySide('<p>neugierig," ich zeige alt</p>', '<p>neugierig,‹ich zeige</p>', lib);
  assert.match(out.html, /<del class="diff-del diff-mark--punct">&quot;<\/del><span class="diff-eq"> ich zeige <\/span>/);
  assert.match(out.html, /<ins class="diff-add diff-mark--punct">‹<\/ins>/);
  assert.match(out.html, / <\/span><del class="diff-del">alt<\/del>/);
});

test('parseBlocks: nur Blattbloecke — Container verdoppeln keinen Text', () => {
  const blocks = parseBlocks('<blockquote><p>Zitat eins</p><p>Zitat zwei</p></blockquote><ul><li><p>Punkt</p></li><li>Flach</li></ul>');
  assert.deepEqual(blocks, [
    { tag: 'p', text: 'Zitat eins' },
    { tag: 'p', text: 'Zitat zwei' },
    { tag: 'p', text: 'Punkt' },
    { tag: 'li', text: 'Flach' },
  ]);
});

test('parseBlocks: Tabellenzellen und Bildunterschriften sind Bloecke', () => {
  const blocks = parseBlocks('<table><tr><th>Kopf</th><td>Zelle</td></tr></table><figure><img src="a.png"><figcaption>Bildtext</figcaption></figure>');
  assert.deepEqual(blocks.map(b => b.text), ['Kopf', 'Zelle', 'Bildtext']);
});

test('parseBlocks: Bilder nur mit imageLabel, in Dokument-Reihenfolge', () => {
  const html = '<p>Vor <img src="/img/foto%20a.png?x=1"></p><p><img alt="Karte" src="k.png"></p><p>Nach</p>';
  assert.deepEqual(parseBlocks(html).map(b => b.text), ['Vor', 'Nach']);
  const withImg = parseBlocks(html, { imageLabel: (n) => `[${n}]` });
  assert.deepEqual(withImg, [
    { tag: 'p', text: 'Vor' },
    { tag: 'img', text: '[foto a.png]' },
    { tag: 'img', text: '[Karte]' },
    { tag: 'p', text: 'Nach' },
  ]);
});

test('renderSideBySide: Tabellenzelle geaendert → kein «unveraendert»', () => {
  const a = '<p>Kopf</p><table><tr><td>alt</td></tr></table>';
  const b = '<p>Kopf</p><table><tr><td>neu</td></tr></table>';
  const out = renderSideBySide(a, b, Diff);
  assert.equal(out.unchanged, false);
  assert.match(out.html, /diff-add[^>]*>neu</);
});

test('renderSideBySide: eingefuegtes Bild erscheint mit imageLabel', () => {
  const out = renderSideBySide('<p>A</p>', '<p>A</p><p><img src="x.png"></p>', Diff, { imageLabel: (n) => `Bild ${n}` });
  assert.equal(out.unchanged, false);
  assert.match(out.html, /diff-cell--img[\s\S]*Bild x\.png/);
});

test('renderSideBySide: reine Formatierung → unchanged (Tag-Grenze vor Satzzeichen)', () => {
  const out = renderSideBySide('<p>Text Absatz.</p>', '<p>Text <strong>Absatz</strong>.</p>', Diff);
  assert.equal(out.unchanged, true);
  assert.equal(renderInline('<p>Text Absatz.</p>', '<p>Text <strong>Absatz</strong>.</p>', Diff).unchanged, true);
});
