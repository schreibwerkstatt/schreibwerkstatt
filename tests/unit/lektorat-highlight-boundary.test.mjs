// Unit-Tests fuer public/js/book/page-view.js#buildHighlightedHtml — Lektorat-
// Marken, deren Fundstelle eine Blockgrenze ueberspannt.
//
// Warum diese Schicht: ein <mark> ist phrasing content. Ueberspannt es `</p><p>`,
// schliesst der Parser es am ersten `</p>` implizit, und der Rest der Fundstelle
// steht ohne Markierung da. Die Marke wird darum je Text-Segment gesetzt. Am
// Listenende stehen zwei Schliess-Tags vor dem naechsten Oeffner
// (`</li></ul><p>`) — auch das ist EINE Grenze.
//
// Assertions ueber einen Re-Parse: entscheidend ist, dass jedes <mark> ganz in
// einem Block liegt und zusammen die Fundstelle abdeckt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
window.matchMedia = () => ({ matches: false, addEventListener() {} });

const { buildHighlightedHtml } = await import('../../public/js/book/page-view.js');

function marks(html) {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return [...document.querySelectorAll('mark')].map(m => ({
    text: m.textContent,
    parent: m.parentElement.tagName.toLowerCase(),
    hasBlockChild: !!m.querySelector('p,li,ul,ol,div'),
  }));
}

test('Absatzgrenze: je Absatz ein <mark>', () => {
  const out = buildHighlightedHtml('<p>a b</p><p>c d</p>', [{ original: 'b c', typ: 'grammatik' }], [false]);
  assert.deepEqual(marks(out).map(m => [m.text, m.parent]), [['b', 'p'], ['c', 'p']]);
});

test('Listenende in Absatz: </li></ul><p> ist eine Grenze', () => {
  const html = '<ul><li>Punkt eins endet hier</li></ul><p>Und weiter geht es.</p>';
  const out = buildHighlightedHtml(html, [{ original: 'endet hier Und weiter', typ: 'grammatik' }], [false]);
  const m = marks(out);
  assert.deepEqual(m.map(x => [x.text, x.parent]), [['endet hier', 'li'], ['Und weiter', 'p']]);
  assert.ok(m.every(x => !x.hasBlockChild));
  assert.ok(out.includes('</li></ul><p>'), 'Blockstruktur bleibt unveraendert');
});

test('Fundstelle innerhalb eines Absatzes: genau ein <mark>', () => {
  const out = buildHighlightedHtml('<p>Der Hund bellt laut.</p>', [{ original: 'bellt', typ: 'grammatik' }], [false]);
  assert.deepEqual(marks(out).map(m => m.text), ['bellt']);
});
