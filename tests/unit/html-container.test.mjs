// insideClassDiv: liegt eine Stelle in div.poem / div.msg-thread? Trägt den
// Vers-Umbruch-Schutz (html-find.js) und die Vorauswahl der Lektorat-Befunde
// im Nachrichtenverlauf (editor/lektorat.js#findingInMsgThread).
import test from 'node:test';
import assert from 'node:assert/strict';
import { insideClassDiv } from '../../public/js/utils/html-container.js';
import { findInHtml } from '../../public/js/utils/html-find.js';

const HTML = '<p>Er schrieb daa.</p>'
  + '<div class="msg-thread"><p class="msg-name">Lena</p><p class="msg-in">bist du schon daa??</p></div>'
  + '<p>Danach kam niemmand.</p>';
const at = (needle) => findInHtml(HTML, needle).htmlStart;

test('Stelle im Verlauf, davor und dahinter', () => {
  assert.equal(insideClassDiv(HTML, at('bist du schon'), 'msg-thread'), true);
  assert.equal(insideClassDiv(HTML, at('Lena'), 'msg-thread'), true);
  assert.equal(insideClassDiv(HTML, at('Er schrieb'), 'msg-thread'), false);
  assert.equal(insideClassDiv(HTML, at('niemmand'), 'msg-thread'), false);
});

test('Klasse muss als ganzes Wort stehen, auch mit weiteren Klassen', () => {
  const h = '<div class="x msg-thread y"><p>a</p></div><div class="msg-threadish"><p>b</p></div>';
  assert.equal(insideClassDiv(h, h.indexOf('a<'), 'msg-thread'), true);
  assert.equal(insideClassDiv(h, h.indexOf('b<'), 'msg-thread'), false);
  assert.equal(insideClassDiv(h, h.indexOf('a<'), 'poem'), false);
});

test('Einfache Anführungszeichen am class-Attribut', () => {
  const h = "<div class='poem'><p>Vers</p></div>";
  assert.equal(insideClassDiv(h, h.indexOf('Vers'), 'poem'), true);
});
