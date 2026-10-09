// LanguageTool-Popover darf das beanstandete Wort nie zudecken: passt er weder
// unter noch ueber den Anker, wird er auf der geraeumigeren Seite gekappt statt
// an die Oberkante des Sichtbereichs (= aufs Wort) geklemmt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeVertical } from '../../public/js/cards/editor-spellcheck/position.js';

// Popover-Attrappe: Hoehe = min(natuerliche Hoehe, gesetzte max-height).
function fakeEl(height) {
  const el = {
    style: { maxHeight: '' },
    getBoundingClientRect() {
      const cap = parseFloat(el.style.maxHeight);
      return { height: Number.isFinite(cap) ? Math.min(height, cap) : height };
    },
  };
  return el;
}
const anchor = (top, h = 20) => ({ top, bottom: top + h });

function assertNoOverlap(el, top, a) {
  const h = el.getBoundingClientRect().height;
  assert.ok(top + h <= a.top || top >= a.bottom,
    `Popover [${top}, ${top + h}] ueberdeckt Anker [${a.top}, ${a.bottom}]`);
}

test('passt unten → unter dem Anker, ungekappt', () => {
  const el = fakeEl(200); const a = anchor(100);
  const top = placeVertical(el, a, 0, 800);
  assert.equal(top, a.bottom + 4);
  assert.equal(el.style.maxHeight, '');
});

test('passt nur oben → darueber, buendig am Anker', () => {
  const el = fakeEl(200); const a = anchor(600);
  const top = placeVertical(el, a, 0, 700);
  assert.equal(top + 200, a.top - 4);
});

test('passt nirgends, oben mehr Platz → oben gekappt, Wort frei', () => {
  // Notebook-Scroller (70vh) mit hohem Popover, Wort im unteren Drittel.
  const el = fakeEl(500); const a = anchor(400);
  const top = placeVertical(el, a, 100, 600);
  assert.notEqual(el.style.maxHeight, '');
  assertNoOverlap(el, top, a);
  assert.ok(top >= 100);
});

test('passt nirgends, unten mehr Platz → unten gekappt', () => {
  const el = fakeEl(500); const a = anchor(200);
  const top = placeVertical(el, a, 100, 600);
  assert.equal(top, a.bottom + 4);
  assert.notEqual(el.style.maxHeight, '');
  assertNoOverlap(el, top, a);
});

test('Wort knapp unter der Oberkante, kaum Platz → nie aufs Wort geklemmt', () => {
  const el = fakeEl(300); const a = anchor(110);
  const top = placeVertical(el, a, 100, 300);
  assertNoOverlap(el, top, a);
});

test('Remount setzt eine alte Kappung zurueck', () => {
  const el = fakeEl(200); el.style.maxHeight = '50px';
  placeVertical(el, anchor(100), 0, 800);
  assert.equal(el.style.maxHeight, '');
});
