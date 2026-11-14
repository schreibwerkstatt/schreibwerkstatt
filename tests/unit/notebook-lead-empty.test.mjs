// Unit-Tests für editor/notebook/read-view.js#markLeadingEmptyParas: die
// Leseansicht des Notebook-Editors versteckt Leerabsätze vor dem ersten Inhalt
// über eine Klasse aus dem Render-String statt über einen Geschwister-Selektor
// im CSS (der kostete im Edit-Modus bei jedem Enter einen Stil-Lauf über den
// ganzen Editor). Test-HTML sind statische Literale.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { markLeadingEmptyParas } = await import('../../public/js/editor/notebook/read-view.js');

test('führende Leerabsätze bekommen .pcv-lead-empty, der Rest bleibt unverändert', () => {
  const html = '<p><br></p><p></p>\n<p data-bid="x"> </p><p>Text</p><p><br></p>';
  assert.equal(
    markLeadingEmptyParas(html),
    '<p class="pcv-lead-empty"></p><p class="pcv-lead-empty"></p>\n<p data-bid="x" class="pcv-lead-empty"></p><p>Text</p><p><br></p>',
  );
});

test('vorhandene Klasse wird ergänzt, nicht verdoppelt', () => {
  assert.equal(markLeadingEmptyParas('<p class="msg-in"><br></p><h2>x</h2>'), '<p class="pcv-lead-empty msg-in"></p><h2>x</h2>');
});

test('ohne führenden Leerabsatz: identischer String', () => {
  for (const html of ['<p>a</p><p><br></p>', '<h2>T</h2><p></p>', '<p><i><br></i></p>', '', null]) {
    assert.equal(markLeadingEmptyParas(html), html);
  }
});

test('page-view.css trägt keinen Geschwister-Selektor über leere Absätze mehr', () => {
  const css = fs.readFileSync(new URL('../../public/css/page/page-view.css', import.meta.url), 'utf8');
  assert.ok(css.includes('p.pcv-lead-empty'));
  assert.ok(!/br:only-child\)\)[^{]*~/.test(css), 'Geschwister-Selektor über Leerabsätze ist zurück');
});
