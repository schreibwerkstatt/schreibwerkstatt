// Regression-Sentinel: Server (lib/html-text.js) und Frontend
// (public/js/html-text.js) MUSSEN bit-identische Plain-Text-Normalisierung
// liefern. Konsumiert von routes/sync.js, lib/search.js, db/page-revisions.js,
// public/js/book/tree.js (_syncPageStatsAfterSave), page-revision-diff.js.
// Drift bricht page_stats, Token-Schaetzungen, Diff-Anzeige und Phantom-Rev-
// Dedup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { htmlToPlainText as feNormalize } from '../../public/js/html-text.js';

const require_ = createRequire(import.meta.url);
const { htmlToPlainText: beNormalize } = require_('../../lib/html-text.js');
const { NAMED_ENTITIES: BE_ENTITIES } = require_('../../lib/html-entities.js');
import { NAMED_ENTITIES as FE_ENTITIES } from '../../public/js/html-entities.js';

test('Entity-Tabelle: Server und Frontend identisch', () => {
  assert.deepEqual({ ...FE_ENTITIES }, { ...BE_ENTITIES });
});

test('Benannte Entities erzeugen keine Phantom-Wörter', () => {
  assert.equal(beNormalize('<p>f&uuml;r &hellip;</p>'), 'für …');
});

const CASES = [
  ['<h1>Title</h1>\n<p>Para 1</p>\n<p>Para 2</p>', 'mehrzeiliger HTML mit Block-Boundaries'],
  ['<p>Hello   <strong>World</strong></p>', 'Inline-Tags + multi-space'],
  ['<div><p>A</p><p>B</p></div>', 'verschachtelte Blocks ohne Inter-Tag-Whitespace'],
  ['<h1>X</h1>\n\n\n<p>Y</p>', 'mehrere Newlines zwischen Tags'],
  ['<p></p><p>Lonely</p>', 'leerer Block + voller Block'],
  ['', 'leerer String'],
  ['<p>   </p>', 'nur Whitespace'],
  ['Text ohne Tags', 'plain text'],
  ['<p>Wort  mit  Doppelspaces</p>', 'doppel-spaces innerhalb Block'],
  ['<ul><li>A</li><li>B</li><li>C</li></ul>', 'Liste'],
  ['<p>trailing nbsp&#160;</p>', 'numerische NBSP-Entity am Block-Ende'],
  ['<p>nbsp&nbsp;named</p>', 'named NBSP-Entity inline'],
  ['<p>A&amp;B</p>', 'amp-Entity'],
  ['<p>&lt;tag&gt;</p>', 'lt/gt-Entity'],
  ['<p>&quot;quote&quot;</p>', 'quot-Entity'],
  ['<p>hex&#xa0;trail</p>', 'hex-NBSP-Entity'],
  ['<p>foo&unknown;bar</p>', 'unbekanntes Entity bleibt literal'],
  ['<p>f&uuml;r &Auml;rger &szlig;</p>', 'benannte Umlaut-Entities'],
  ['<p>Silben&shy;trennung &hellip; &bdquo;x&ldquo; &ndash;</p>', 'typografische Entities'],
  ['<p>&frac12; &sup2;</p>', 'Entity-Namen mit Ziffern'],
];

for (const [html, label] of CASES) {
  test(`Parity Server↔Frontend: ${label}`, () => {
    const s = beNormalize(html);
    const f = feNormalize(html);
    assert.equal(f, s, `Frontend "${f}" != Server "${s}"`);
    assert.equal(f.length, s.length);
  });
}

test('Entity-Decode: trailing &#160; kollabiert zu Null-Chars', () => {
  // Pflicht fuer Phantom-Rev-Fix: rev-A endet auf `&#160;`, rev-B nicht.
  // Vorher zaehlte rev-A 6 Zeichen mehr; nach Decode 0 Zeichen Differenz.
  const withNbsp = '<p>als gewöhnlich.&#160;</p>';
  const withoutNbsp = '<p>als gewöhnlich.</p>';
  assert.equal(beNormalize(withNbsp), beNormalize(withoutNbsp));
  assert.equal(feNormalize(withNbsp), feNormalize(withoutNbsp));
});

test('Entity-Decode: named &nbsp; collapsed', () => {
  assert.equal(beNormalize('<p>a&nbsp;b</p>'), 'a b');
  assert.equal(feNormalize('<p>a&nbsp;b</p>'), 'a b');
});

test('Entity-Decode: numerische Entity wird dekodiert', () => {
  assert.equal(beNormalize('<p>A&#65;</p>'), 'AA');
  assert.equal(feNormalize('<p>A&#65;</p>'), 'AA');
});

test('Unbekanntes Entity bleibt literal', () => {
  assert.equal(beNormalize('&xx;'), '&xx;');
  assert.equal(feNormalize('&xx;'), '&xx;');
});

test('Whitespace-Bias eliminiert (50-Paragraph-Stress)', () => {
  const html = Array.from({ length: 50 }, (_, i) => `<p>Para ${i}</p>`).join('\n');
  const f = feNormalize(html);
  const s = beNormalize(html);
  assert.equal(f, s);
  assert.ok(!f.includes('\n'));
});
