// Theme- und Schatten-Werte leben in public/css/tokens/, nicht in Feature-Dateien.
//
// WARUM: ein `[data-theme="dark"] .x { … }` in einer Feature-Datei ist eine
// zweite Dark-Palette neben tokens/colors.css — sie driftet, sobald der Token
// sich aendert, und der Kontrast-Gate (css-contrast.test.mjs) sieht sie nicht.
// Dasselbe gilt fuer rohe Schattenfarben: --shadow-* erbt im Dark-Theme
// dunklere Alphas automatisch, ein `rgba(0,0,0,.18)` bleibt hell-tauglich.
// Theme-abhaengige Werte kommen als Token-Paar nach tokens/colors.css.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const CSS_DIR = join(ROOT, 'public', 'css');
// share/ hat ein eigenes Token-Universum (--share-*) mit eigener Theme-Aufloesung.
const EXCLUDED = ['css/tokens/', 'css/share/', 'css/share.css'];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'vendor') continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (e.endsWith('.css')) out.push(f);
  }
  return out;
}

function files() {
  return walk(CSS_DIR)
    .map((f) => [relative(join(ROOT, 'public'), f).split('\\').join('/'), f])
    .filter(([r]) => !EXCLUDED.some((e) => r.startsWith(e)))
    .map(([r, f]) => [r, readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))]);
}
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

test('kein [data-theme]-Selektor ausserhalb von tokens/ und share/', () => {
  const hits = [];
  for (const [r, src] of files()) {
    for (const m of src.matchAll(/\[data-theme\b/g)) hits.push(`${r}:${lineOf(src, m.index)}`);
  }
  assert.equal(hits.length, 0,
    `Theme-Override in Feature-Datei — Token-Paar in tokens/colors.css anlegen:\n  ${hits.join('\n  ')}`);
});

test('box-shadow ohne rohe Farbe (rgba()/hex) ausserhalb von tokens/', () => {
  const hits = [];
  for (const [r, src] of files()) {
    for (const m of src.matchAll(/(?<![\w-])box-shadow\s*:\s*([^;{}]+);/g)) {
      if (/rgba?\(|hsla?\(|#[0-9a-fA-F]{3,8}\b/.test(m[1])) hits.push(`${r}:${lineOf(src, m.index)} ${m[0].trim()}`);
    }
  }
  assert.equal(hits.length, 0,
    `Rohe Schattenfarbe — --shadow-* (tokens/motion.css) bzw. --color-shadow-* nehmen:\n  ${hits.join('\n  ')}`);
});
