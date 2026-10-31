// Gate fuer das Lade-Skelett (DESIGN.md „Skeleton-Loader"):
// Listen- und Kachel-Platzhalter rendert ausschliesslich die Direktive
// `x-skeleton` (public/js/skeleton.js). Die Zeile stand sieben Mal kopiert in
// den Partials, je mit eigener Anzahl und eigener Hülle.
//
// Geprueft wird:
//   1. Kein Partial / index.html schreibt `entity-skeleton-row`,
//      `entity-skeleton-cell` oder `skeleton-tile` selbst.
//   2. Kein Element traegt die Klasse `entity-skeleton` von Hand (setzt die
//      Direktive).
//   3. `skeletonMarkup` liefert die verlangte Anzahl, gedeckelt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const INDEX_HTML = join(REPO_ROOT, 'public', 'index.html');
const rel = (p) => relative(REPO_ROOT, p);

const htmlFiles = () => [
  INDEX_HTML,
  ...readdirSync(PARTIALS_DIR).filter(f => f.endsWith('.html')).map(f => join(PARTIALS_DIR, f)),
];

// Eigene Skelett-Formen mit eigenem Markup (nicht Liste/Kachel).
const OWN_SHAPE = /\b(recherche-skeleton|chat-skeleton|page-content-skeleton)/;

test('Skelett-Zeilen und -Kacheln nur über x-skeleton', () => {
  const offenders = [];
  for (const file of htmlFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (OWN_SHAPE.test(line)) return;
      if (/class="[^"]*\b(entity-skeleton-row|entity-skeleton-cell|skeleton-tile)\b/.test(line)
        || /class="[^"]*\bentity-skeleton\b(?!-)/.test(line)) {
        offenders.push(`${rel(file)}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'Handgeschriebenes Skelett — statt dessen <div x-show="…" x-skeleton="n"></div> (bzw. x-skeleton.tiles):\n'
    + offenders.join('\n'));
});

test('skeletonMarkup: Anzahl und Deckel', async () => {
  const { skeletonMarkup } = await import('../../public/js/skeleton.js');
  const count = (html, cls) => html.split(`class="${cls}"`).length - 1;
  assert.equal(count(skeletonMarkup('rows', 4), 'entity-skeleton-row'), 4);
  assert.equal(count(skeletonMarkup('rows', ''), 'entity-skeleton-row'), 6);
  assert.equal(count(skeletonMarkup('tiles', ''), 'overview-tile skeleton-tile'), 3);
  assert.equal(count(skeletonMarkup('rows', 999), 'entity-skeleton-row'), 20);
});
