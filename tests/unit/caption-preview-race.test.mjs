// Unit-Tests fuer ueberlappende Laeufe der Legenden-Nummern
// (public/js/xrefs/caption-preview.js) und den geteilten Ziel-Fetch
// (public/js/xrefs/target-cache.js).
//
// Warum diese Schicht: die Leseansichten (Notebook + Bucheditor) stossen
// `stampCaptionNumbers` aus mehreren Watchern an — bei der Rueckkehr aus dem
// Edit-Modus aendern sich HTML und Modus im selben Tick. Beide Laeufe raeumten
// vor ihrem `await` auf und setzten danach beide ein: „Abb. 1.1: Abb. 1.1:".
// Das ist reine Promise-Reihenfolge und braucht keinen Browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.document = document;

let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls++;
  await new Promise(r => setTimeout(r, 5));
  return {
    ok: true,
    json: async () => ({
      chapters: [{ target: 1, title: 'Eins' }],
      figures: [{ target: 'b1', chapterId: 1 }],
      tables: [],
      figureNumbering: true,
      tableNumbering: true,
      lang: 'de',
    }),
  };
};

const { stampCaptionNumbers } = await import('../../public/js/xrefs/caption-preview.js');
const { loadXrefTargets, invalidateXrefTargetCache } = await import('../../public/js/xrefs/target-cache.js');

function view() {
  const el = document.createElement('div');
  el.innerHTML = '<figure data-bid="b1"><img src="x.png"><figcaption>Der Käfer</figcaption></figure>';
  return el;
}

test('zwei gleichzeitige Laeufe hinterlassen genau ein Badge', async () => {
  invalidateXrefTargetCache();
  const el = view();
  await Promise.all([stampCaptionNumbers(el, 7), stampCaptionNumbers(el, 7)]);
  const badges = el.querySelectorAll('span.xref-num');
  assert.equal(badges.length, 1);
  assert.equal(badges[0].textContent, 'Abb. 1.1: ');
});

test('auch mit warmem Cache: drei Laeufe, ein Badge', async () => {
  const el = view();
  await stampCaptionNumbers(el, 7);
  await Promise.all([stampCaptionNumbers(el, 7), stampCaptionNumbers(el, 7), stampCaptionNumbers(el, 7)]);
  assert.equal(el.querySelectorAll('span.xref-num').length, 1);
});

test('gleichzeitige Aufrufer teilen sich einen Fetch', async () => {
  invalidateXrefTargetCache();
  fetchCalls = 0;
  const [a, b] = await Promise.all([loadXrefTargets(9), loadXrefTargets(9)]);
  assert.equal(fetchCalls, 1);
  assert.equal(a, b);
  await loadXrefTargets(9);
  assert.equal(fetchCalls, 1, 'danach aus dem Cache');
});

test('Invalidierung waehrend des Fetches: Antwort wird nicht gecacht', async () => {
  invalidateXrefTargetCache();
  fetchCalls = 0;
  const pending = loadXrefTargets(11);
  invalidateXrefTargetCache(11);
  await pending;
  await loadXrefTargets(11);
  assert.equal(fetchCalls, 2);
});
