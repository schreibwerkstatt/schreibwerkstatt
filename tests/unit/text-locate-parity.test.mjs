// Fundstellen-Parität: der DOM-Index (editor/shared/text-locate.js, Lektorat im
// Notebook-Edit-Modus + Abschnitts-Chat) muss dieselben Stellen finden wie die
// HTML-Sicht (utils/html-find.js, Leseansicht + Ersetzungs-Kern). Sonst steht
// ein Befund in der Leseansicht markiert da und gilt im Edit-Modus als
// umgeschrieben (oder umgekehrt). Gemeinsame Regel: text-match.js#tagGapIsSpace.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window ??= window;
globalThis.document = window.document;
globalThis.NodeFilter ??= window.NodeFilter || { SHOW_TEXT: 4 };

const { buildLocateIndex, locateAllInIndex } = await import('../../public/js/editor/shared/text-locate.js');
const { countInHtml } = await import('../../public/js/utils/html-find.js');

function domCount(html, needle) {
  const { document } = parseHTML(`<!doctype html><html><body><div id="c">${html}</div></body></html>`);
  globalThis.document = document;
  return locateAllInIndex(buildLocateIndex(document.getElementById('c')), needle).length;
}

const CASES = [
  // [html, needle, erwartete Anzahl]
  ['<p>Er ging.</p><p>Hallo</p>', 'ging. Hallo', 1],
  ['<p>Er ging.</p><p>Hallo</p>', 'ging.Hallo', 0],
  ['<p><b>Un</b>glück</p>', 'Un glück', 1],
  ['<p><b>Un</b>glück</p>', 'Unglück', 0],
  ['<p>siehe <a href="#">Asianometry</a>.</p>', 'Asianometry.', 1],
  ['<p>siehe <a href="#">Asianometry</a> .</p>', 'Asianometry .', 1],
  ['<p>(<em>kursiv</em>)</p>', '(kursiv)', 1],
  ['<p>«<i>Ja</i>», sagte er</p>', '«Ja», sagte er', 1],
  ['<p>eins<br>zwei</p>', 'eins zwei', 1],
  ['<ul><li>a</li><li>b</li></ul><p>c</p>', 'b c', 1],
  ['<p>und ging und ging</p>', 'und ging', 2],
  ['<p>Wort <span class="x">mit</span> Span</p>', 'Wort mit Span', 1],
];

for (const [html, needle, want] of CASES) {
  test(`Parität: ${JSON.stringify(needle)} in ${html}`, () => {
    assert.equal(countInHtml(html, needle), want, 'HTML-Sicht');
    assert.equal(domCount(html, needle), want, 'DOM-Index');
  });
}
