// Bucheditor-Find/Replace: Anzeige-Artefakte inaktiver Blöcke (gerendertes
// Mermaid-SVG, Nummern-Badges der Beschriftungen) sind kein Manuskript — kein
// Treffer darin, und das Replace-Ergebnis in `block.html` enthält sie nicht.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document, window } = parseHTML('<body></body>');
globalThis.document = document;
globalThis.window = globalThis.window || window;
globalThis.NodeFilter = { SHOW_ELEMENT: 1, SHOW_TEXT: 4 };

const { filterArtefactMatch, cleanBlockHtml } = await import('../../public/js/cards/book-editor/find.js');
const { collectMatches } = await import('../../public/js/editor/shared/text-find.js');

function block(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

const HTML = '<pre class="mermaid mermaid--rendered">graph TD; Knoten </pre>'
  + '<div class="mermaid-render"><svg><text> Knoten </text></svg></div>'
  + '<figure><figcaption><span class="xref-num">Abb. 1: </span>Knoten zeigt</figcaption></figure>';

test('Treffer im SVG, im ausgeblendeten Quelltext und im Nummern-Badge gelten als Artefakt', () => {
  const el = block(HTML);
  const matches = collectMatches(el, 'Knoten', {});
  const kept = matches.map(m => filterArtefactMatch(m, el)).filter(Boolean);
  // Nur der Legendentext bleibt: das SVG ist Bild, der Quelltext daneben ist
  // ausgeblendet, solange das Bild steht (Treffer wäre unsichtbar).
  assert.equal(matches.length, 3);
  assert.equal(kept.length, 1);
  assert.ok(kept.every(m => !m.startNode.parentElement.closest('.mermaid-render, .mermaid--rendered, .xref-num')));
  // Treffer direkt hinter dem Badge beginnt im Legenden-Node, nicht im Badge.
  assert.equal(kept[0].startNode.nodeValue, 'Knoten zeigt');
  assert.equal(kept[0].startOffset, 0);
});

test('Quelltext ohne Bild (aktiver Block) wird gefunden', () => {
  const el = block('<pre class="mermaid">graph TD; Knoten</pre>');
  const kept = collectMatches(el, 'Knoten', {}).map(m => filterArtefactMatch(m, el)).filter(Boolean);
  assert.equal(kept.length, 1);
});

test('Badge-Text "Abb." wird nicht gefunden', () => {
  const el = block(HTML);
  const kept = collectMatches(el, 'Abb. 1', {}).map(m => filterArtefactMatch(m, el)).filter(Boolean);
  assert.equal(kept.length, 0);
});

test('cleanBlockHtml: SVG, Render-Klasse und Badge fallen, Live-DOM bleibt', () => {
  const el = block(HTML);
  const out = cleanBlockHtml(el);
  assert.ok(!out.includes('mermaid-render'));
  assert.ok(!out.includes('mermaid--rendered'));
  assert.ok(!out.includes('xref-num'));
  assert.ok(out.includes('graph TD'));
  assert.ok(out.includes('Knoten zeigt'));
  // Das sichtbare Bild bleibt stehen.
  assert.ok(el.querySelector('.mermaid-render'));
  assert.ok(el.querySelector('.xref-num'));
});
