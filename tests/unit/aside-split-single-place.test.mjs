// Split mit Leiste an genau einem Ort (DESIGN.md „Split mit Leiste").
//
// Hauptinhalt links, klebende Leiste rechts gab es fünfmal, viermal anders
// gebaut: eigene Spaltenbreite, eigener Abstand, Höhendeckel mal an der Leiste,
// mal nur am inneren Verlauf — dort lief die Leiste auf niedrigen Bildschirmen
// über den Viewport, und ihr Eingabefeld war erst am Seitenende erreichbar.
// Die Geometrie steht deshalb nur in layout/aside-split.css; Konsumenten setzen
// `--aside-w` / `--aside-scroll-max` am Split-Element.
//
// Geprüft wird die Form, an der ein Nachbau zu erkennen ist:
//   1. eine klebende Spalte mit Viewport-Höhendeckel (`position: sticky` +
//      `max-height: …vh`) steht nur in aside-split.css oder — für den
//      Seitenbaum — in twocolumn.css;
//   2. `.aside-split*`-Klassen bekommen ihre Geometrie nirgends sonst;
//   3. die Layout-Dateien kennen keine Karten-IDs (eine neue Leistenkarte
//      markiert sich selbst mit `.aside-split-aside`, statt in twocolumn.css
//      nachgetragen zu werden).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const CSS_DIR = join(REPO_ROOT, 'public', 'css');
const rel = (p) => relative(join(REPO_ROOT, 'public'), p).split('\\').join('/');

const HOME = 'css/layout/aside-split.css';
const STICKY_COLUMN_OWNERS = new Set([HOME, 'css/layout/twocolumn.css']);
// Bucheditor: Dreispalten-Raster Inhaltsverzeichnis | Stream | Kommentarschiene
// (docs/book-editor.md) — eine Vollbild-Arbeitsfläche mit eigener Geometrie,
// keine Leiste neben einem Hauptinhalt.
const STICKY_COLUMN_EXCEPTIONS = new Set(['css/editor/book/book-editor.css|.book-editor-outline']);
// Share-Reader: eigenes Token-Set, pre-auth, ohne App-Layout (docs/share-link.md).
const EXCLUDED = ['css/share/', 'css/share.css'];

function cssFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...cssFiles(p));
    else if (name.endsWith('.css')) out.push(p);
  }
  return out;
}

// Innerste `selektor { deklarationen }`-Blöcke (Kommentare entfernt).
function blocks(src) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(m => ({ selector: m[1].trim(), body: m[2] }));
}

const FILES = cssFiles(CSS_DIR)
  .map(p => ({ file: rel(p), src: readFileSync(p, 'utf8') }))
  .filter(f => !EXCLUDED.some(x => f.file.startsWith(x)));

test('aside-split.css existiert und trägt die Leisten-Geometrie', () => {
  const home = FILES.find(f => f.file === HOME);
  assert.ok(home, `${HOME} fehlt`);
  const b = blocks(home.src);
  assert.ok(b.some(x => /\.aside-split--on\b/.test(x.selector) && /grid-template-columns/.test(x.body)));
  assert.ok(b.some(x => /\.aside-split-aside\b/.test(x.selector) && /position:\s*sticky/.test(x.body)));
});

test('Klebende Spalte mit Viewport-Deckel nur in aside-split.css / twocolumn.css', () => {
  const hits = [];
  for (const { file, src } of FILES) {
    if (STICKY_COLUMN_OWNERS.has(file)) continue;
    for (const { selector, body } of blocks(src)) {
      if (STICKY_COLUMN_EXCEPTIONS.has(`${file}|${selector}`)) continue;
      if (/position:\s*sticky/.test(body) && /max-height:[^;]*\d+d?vh/.test(body)) {
        hits.push(`${file}: ${selector}`);
      }
    }
  }
  assert.deepEqual(hits, [],
    'Klebende Spalte nachgebaut — Leiste über `.aside-split` + `.aside-split-aside` ' +
    `(layout/aside-split.css), Breite per --aside-w am Split:\n  ${hits.join('\n  ')}`);
});

test('.aside-split*-Geometrie nur in aside-split.css', () => {
  const GEOMETRY = /(grid-template-columns|position:\s*sticky|max-height|overflow-y)/;
  const hits = [];
  for (const { file, src } of FILES) {
    if (file === HOME) continue;
    for (const { selector, body } of blocks(src)) {
      if (/\.aside-split/.test(selector) && GEOMETRY.test(body)) hits.push(`${file}: ${selector}`);
    }
  }
  assert.deepEqual(hits, [],
    'Leisten-Geometrie ausserhalb von aside-split.css — stattdessen --aside-w / ' +
    `--aside-scroll-max am Split-Element setzen:\n  ${hits.join('\n  ')}`);
});

test('Layout-Dateien kennen keine Karten-IDs', () => {
  const hits = [];
  for (const { file, src } of FILES) {
    if (!file.startsWith('css/layout/')) continue;
    for (const { selector } of blocks(src)) {
      if (/#[\w-]+-card\b/.test(selector)) hits.push(`${file}: ${selector}`);
    }
  }
  assert.deepEqual(hits, [],
    'Karte in einer Layout-Datei verdrahtet — die Karte markiert sich mit ' +
    `.aside-split-aside / .aside-split-scroll:\n  ${hits.join('\n  ')}`);
});
