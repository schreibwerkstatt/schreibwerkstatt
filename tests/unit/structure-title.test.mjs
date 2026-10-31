// Browser-Regel (public/js/structure-title.js: Share-Reader, Bucheditor,
// Sidebar) und Server-Regel (lib/export-builders/shared.js: PDF/Word) fuer
// "Abschnitt heisst wie sein Kapitel" muessen deckungsgleich bleiben — sonst
// zeigt derselbe Buchstand je Ausgabe eine andere Gliederung.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sameStructureTitle: server } = require('../../lib/export-builders/shared.js');
const { sameStructureTitle: browser } = await import('../../public/js/structure-title.js');

const CASES = [
  ['Kapitel 3', 'Kapitel 3'], ['Kapitel 3', 'kapitel 3'], ['  Kapitel\t3 ', 'Kapitel 3'],
  ['Kapitel 3', 'Kapitel 4'], ['', ''], [null, null], [undefined, ''], ['A', null],
  ['Ärger', 'ärger'], ['Szene', 'Szene 1'],
];

test('Browser- und Server-Regel liefern dasselbe Ergebnis', () => {
  for (const [a, b] of CASES) {
    assert.equal(browser(a, b), server(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  }
});

test('Leere Namen gelten nie als gleich', () => {
  assert.equal(browser('', ''), false);
  assert.equal(browser(null, null), false);
});

const { sectionTitleRedundant: serverRedundant } = require('../../lib/export-builders/shared.js');
const { sectionTitleRedundant: browserRedundant, sectionCountsByChapter } = await import('../../public/js/structure-title.js');

const SECTION_CASES = [
  // Einziger Abschnitt: Ueberschrift entfaellt, auch bei abweichendem Namen.
  { index: 0, count: 1, pageName: 'Kapitel 2', chapterName: 'Kapitel 2: Kennenlernen' },
  { index: 0, count: 1, pageName: 'Prologue', chapterName: 'Prologue' },
  // Mehrere Abschnitte: nur der erste gleichnamige.
  { index: 0, count: 3, pageName: 'Szene', chapterName: 'Szene' },
  { index: 0, count: 3, pageName: 'Szene 1', chapterName: 'Szene' },
  { index: 1, count: 3, pageName: 'Szene', chapterName: 'Szene' },
];

test('sectionTitleRedundant: Browser- und Server-Regel deckungsgleich', () => {
  for (const c of SECTION_CASES) {
    assert.equal(browserRedundant(c), serverRedundant(c), JSON.stringify(c));
  }
});

test('Einziger Abschnitt eines Kapitels traegt nie eine eigene Ueberschrift', () => {
  assert.equal(serverRedundant({ index: 0, count: 1, pageName: 'Lilanes WG', chapterName: 'Kapitel 1' }), true);
  assert.equal(serverRedundant({ index: 0, count: 2, pageName: 'Lilanes WG', chapterName: 'Kapitel 1' }), false);
});

test('sectionCountsByChapter zaehlt nur direkte Abschnitte', () => {
  const counts = sectionCountsByChapter([
    { kind: 'page', chapterId: null },
    { kind: 'chapter', chapterId: 1 },
    { kind: 'page', chapterId: 1 },
    { kind: 'chapter', chapterId: 2 },
    { kind: 'page', chapterId: 2 },
    { kind: 'page', chapterId: 2 },
  ]);
  assert.equal(counts.get(1), 1);
  assert.equal(counts.get(2), 2);
  assert.equal(counts.get(null), 1);
});
