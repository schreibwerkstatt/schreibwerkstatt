// Unit-Tests für public/js/editor/notebook/split-html.js («Abschnitt hier
// teilen», Notebook-Editor): Schnittregel am Caret, data-bid-Verhalten,
// Leerabsätze an der Schnittstelle, Kanten (eine Seite leer) und dass der
// Live-Container unangetastet bleibt. Test-HTML sind statische Literale.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document } = parseHTML('<!doctype html><html><body></body></html>');
const { splitEditorAt, splitAtPoint, nodePath, resolvePath } = await import('../../public/js/editor/notebook/split-html.js');

function mount(html) {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

const DOC = '<h2 data-bid="b1">Titel</h2><p data-bid="b2">Eins zwei.</p><p data-bid="b3">Drei <em>vier fünf</em> sechs.</p><p data-bid="b4">Sieben.</p>';

test('Caret mitten im Absatz: Absatz wird geteilt, zweite Hälfte ohne data-bid', () => {
  const el = mount(DOC);
  const em = el.querySelector('em').firstChild; // "vier fünf"
  const r = splitEditorAt(el, em, 5); // nach "vier "
  assert.equal(r.headHtml, '<h2 data-bid="b1">Titel</h2><p data-bid="b2">Eins zwei.</p><p data-bid="b3">Drei <em>vier </em></p>');
  assert.equal(r.tailHtml, '<p><em>fünf</em> sechs.</p><p data-bid="b4">Sieben.</p>');
  assert.equal(el.innerHTML, DOC, 'Live-Container bleibt unverändert');
});

test('Caret am Absatzanfang / -ende: Grenze an der Blockgrenze, data-bid bleibt am Block', () => {
  const el = mount(DOC);
  const start = splitEditorAt(el, el.children[2].firstChild, 0);
  assert.match(start.tailHtml, /^<p data-bid="b3">Drei/);
  assert.doesNotMatch(start.headHtml, /b3/);
  const p4 = el.children[2];
  const end = splitEditorAt(el, p4.lastChild, p4.lastChild.data.length);
  assert.match(end.headHtml, /sechs\.<\/p>$/);
  assert.equal(end.tailHtml, '<p data-bid="b4">Sieben.</p>');
});

test('Leerer Trigger-Absatz (Slash-Menü) fällt an der Schnittstelle weg', () => {
  const el = mount('<p data-bid="a">Vorher.</p><p data-bid="x"><br></p><p data-bid="b">Nachher.</p>');
  const r = splitEditorAt(el, el.children[1], 0);
  assert.equal(r.headHtml, '<p data-bid="a">Vorher.</p>');
  assert.equal(r.tailHtml, '<p data-bid="b">Nachher.</p>');
});

test('Caret in Nicht-Absatz-Block (Liste, Zitat): ganzer Block wandert', () => {
  const el = mount('<p>Davor.</p><ul data-bid="l"><li>eins</li><li>zwei</li></ul><blockquote><p>Zitat</p></blockquote>');
  const li2 = el.querySelector('li + li').firstChild;
  const r = splitEditorAt(el, li2, 2);
  assert.equal(r.headHtml, '<p>Davor.</p>');
  assert.match(r.tailHtml, /^<ul data-bid="l"><li>eins<\/li><li>zwei<\/li><\/ul><blockquote>/);
});

test('Kante: vor oder nach dem Schnitt kein Inhalt → edge', () => {
  const el = mount('<p>Nur ein Absatz.</p>');
  assert.deepEqual(splitEditorAt(el, el.firstChild.firstChild, 0), { error: 'edge' });
  assert.deepEqual(splitEditorAt(el, el.firstChild.firstChild, 15), { error: 'edge' });
  const el2 = mount('<p>Text.</p><p><br></p>');
  assert.deepEqual(splitEditorAt(el2, el2.children[1], 0), { error: 'edge' });
});

test('Bild ohne Text zählt als Inhalt', () => {
  const el = mount('<p>Text.</p><figure><img src="/x.png" alt=""></figure>');
  const r = splitEditorAt(el, el, 1);
  assert.equal(r.headHtml, '<p>Text.</p>');
  assert.match(r.tailHtml, /^<figure>/);
});

test('Punkt ausserhalb des Containers → outside; Pfad-Helfer sind invers', () => {
  const el = mount(DOC);
  const foreign = document.createElement('p');
  assert.deepEqual(splitEditorAt(el, foreign, 0), { error: 'outside' });
  assert.deepEqual(splitAtPoint(el, foreign, 0), { error: 'outside' });
  const node = el.querySelector('em').firstChild;
  assert.equal(resolvePath(el, nodePath(el, node)), node);
});
