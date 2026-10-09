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
