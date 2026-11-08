// TXT-Export (lib/export-builders/txt.js#htmlToText): HTML-Entities werden nach
// dem Tag-Strip dekodiert — im Fliesstext, in Tabellenzellen und in Gedichten.
// Vorher standen `&amp;`, `&nbsp;`, `&quot;`, `&#8212;` roh in der Datei.
//
// Lauf: `node --test tests/unit/export-builders/txt-entities.test.mjs`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTmpDb } from '../_helpers/tmp-db.js';

useTmpDb('txt-entities');
await import('../../../db/schema.js');
const { htmlToText } = await import('../../../lib/export-builders/txt.js');

test('Fliesstext: benannte und numerische Entities dekodiert', () => {
  assert.equal(
    htmlToText('<p>Tom &amp; Jerry sagten &quot;Hallo&quot; &#8212; na&nbsp;ja &#x2019;s</p>'),
    'Tom & Jerry sagten "Hallo" — na ja ’s',
  );
});

test('kodierte Spitzklammern bleiben Text, werden nicht als Tag gestrippt', () => {
  assert.equal(htmlToText('<p>a &lt;b&gt; c</p>'), 'a <b> c');
});

test('Tabellenzellen und Gedichte dekodieren ebenfalls', () => {
  const t = htmlToText('<table><tr><td>A &amp; B</td><td>&quot;x&quot;</td></tr></table>');
  assert.equal(t, 'A & B | "x"');
  const p = htmlToText('<div class="poem"><p>Rose &amp; Dorn</p><p>&#8230;</p></div>');
  assert.equal(p, 'Rose & Dorn\n…');
});

test('Absatz aus nur &nbsp; kollabiert als Leerzeile', () => {
  assert.equal(htmlToText('<p>eins</p><p>&nbsp;</p><p>&nbsp;</p><p>zwei</p>'), 'eins\n\nzwei');
});
