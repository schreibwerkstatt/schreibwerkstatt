// Überschriften sind einzeilig in jedem Export (lib/heading-breaks.js): ein
// <br> in <h1>–<h6> wird zum Leerzeichen, am Rand fällt es weg. Der Editor
// setzt dort keinen Umbruch mehr (shared/soft-break.js#softBreakNoop); das hier
// fängt Alt-Bestand und Import ab.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useTmpDb } from '../_helpers/tmp-db.js';

useTmpDb('heading-breaks-export');
await import('../../../db/schema.js');

const { flattenHeadingBreaks } = await import('../../../lib/heading-breaks.js');
const { buildMd } = await import('../../../lib/export-builders/md.js');
const { buildSubstack } = await import('../../../lib/export-builders/substack.js');
const { buildHtml } = await import('../../../lib/export-builders/html.js');

const bundleOf = (html) => ({
  scope: 'page',
  book: { id: 1, name: 'Buch', slug: 'buch' },
  page: { id: 100, name: 'Seite', slug: 's' },
  groups: [{ chapterId: null, chapter: null, pages: [{ p: { id: 100, name: 'Seite' }, pd: { html } }] }],
});

test('flattenHeadingBreaks: Binnen-<br> → Leerzeichen, Rand-<br> fällt weg', () => {
  assert.equal(flattenHeadingBreaks('<h2 data-bid="a">Erster<br>Teil</h2>'), '<h2 data-bid="a">Erster Teil</h2>');
  assert.equal(flattenHeadingBreaks('<h3>Erster <br/><br> Teil<br></h3>'), '<h3>Erster Teil</h3>');
  assert.equal(flattenHeadingBreaks('<h2><br>Titel</h2>'), '<h2>Titel</h2>');
  assert.equal(flattenHeadingBreaks('<h2><em>A</em><br><em>B</em></h2>'), '<h2><em>A</em> <em>B</em></h2>');
});

test('flattenHeadingBreaks: Absätze, Code und leere Überschrift bleiben', () => {
  const html = '<p>Vers<br>Vers</p><pre><code>a<br><br>b</code></pre><h2><br></h2>';
  assert.equal(flattenHeadingBreaks(html), html);
});

test('Markdown: der Rest der Überschrift bleibt in der Überschrift', async () => {
  const content = await buildMd(bundleOf('<h2>Erster<br>Teil</h2><p>Text</p>'), {});
  const md = content.toString('utf8');
  assert.match(md, /^#+ Erster Teil$/m);
  assert.doesNotMatch(md, /^Teil$/m);
});

test('Substack und HTML: Überschrift ohne <br>', async () => {
  for (const build of [buildSubstack, buildHtml]) {
    const content = await build(bundleOf('<h2>Erster<br>Teil</h2>'), {});
    const out = content.toString('utf8');
    assert.match(out, /Erster Teil/);
    assert.doesNotMatch(out, /Erster<br/);
  }
});
