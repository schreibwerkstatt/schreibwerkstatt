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
//   3. Kein Partial zeigt Daten-Laden als Text (`common.loading` u. ä. per
//      x-text) — das Laden einer Liste/eines Formulars zeigt das Skelett.
//      Laufende Vorgänge („Suche läuft", „KI sucht", Upload) sind kein
//      Daten-Laden und haben eigene Keys.
//   4. `skeletonMarkup` liefert die verlangte Anzahl, gedeckelt.

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

test('Daten-Laden nie als Text-Hinweis', () => {
  const offenders = [];
  // `common.loading` traegt nur noch das aria-label des Skeletts (skeleton.js).
  const TEXT_LOADER = /x-text="(?:\$app\.)?t\('(?:common\.loading|[\w.]+\.(?:loading|loadingMore))'\)"/;
  // Vorgaenge mit eigenem Verb, kein Daten-Laden — und der Synonym-Picker:
  // seine Spinner-Zeile teilt er mit dem Alpine-freien Kontextmenü-Picker
  // (editor-synonyme/controller.js) und der Zeile „KI sucht …" daneben.
  const PROCESS_KEYS = /'(search\.loading|komplett\.delta\.loading|editor\.synonym\.loading)'/;
  for (const file of htmlFiles()) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (TEXT_LOADER.test(line) && !PROCESS_KEYS.test(line)) offenders.push(`${rel(file)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [],
    'Lade-Text statt Skelett — <div x-show="…" x-skeleton="n" x-cloak></div> (Buttons: .spinner + festes Label):\n'
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
