// Gate fuer den Personen-Chip (DESIGN.md „Personen-Chip", public/js/user-chip.js):
// Avatar + Name einer Person entstehen ausschliesslich in der Direktive
// `x-user-chip`, die Optik steht ausschliesslich in components/user-chip.css.
//
// Geprueft wird:
//   1. Kein Markup (Partials, index.html, Browser-JS ausser user-chip.js) baut
//      `user-chip`, `user-chip__avatar` oder `user-chip__name` von Hand.
//   2. Jedes `x-user-chip`-Element ist leer — den Inhalt schreibt die Direktive.
//   3. Ausserhalb von user-chip.css stylt keine Regel die Innenteile
//      (`.user-chip__…`) oder `--self`; Layout-Regeln am Chip selbst (Flex in
//      der Wirtszeile) bleiben erlaubt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const rel = (p) => relative(REPO_ROOT, p);
const CHIP_JS = 'public/js/user-chip.js';
const CHIP_CSS = 'public/css/components/user-chip.css';

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'vendor' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const markupFiles = [
  ...walk(join(REPO_ROOT, 'public', 'partials'), '.html'),
  join(REPO_ROOT, 'public', 'index.html'),
  ...walk(join(REPO_ROOT, 'public', 'js'), '.js'),
].filter(f => rel(f) !== CHIP_JS);

test('Personen-Chip nur ueber x-user-chip, kein handgebautes Markup', () => {
  const bad = [];
  for (const f of markupFiles) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/class(?:Name)?\s*=\s*["'`][^"'`]*\buser-chip(?:__avatar|__name)?\b(?!-)/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      bad.push(`${rel(f)}:${line}`);
    }
  }
  assert.deepEqual(bad, [], `user-chip von Hand gebaut — <span x-user-chip="email"></span> verwenden:\n  ${bad.join('\n  ')}`);
});

test('x-user-chip-Elemente sind leer', () => {
  const bad = [];
  for (const f of markupFiles.filter(p => p.endsWith('.html'))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/<(\w+)\b[^>]*\bx-user-chip=[^>]*>([\s\S]*?)<\/\1>/g)) {
      if (m[2].trim()) bad.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(bad, [], `x-user-chip mit Inhalt — Element leer lassen:\n  ${bad.join('\n  ')}`);
});

test('Chip-Optik nur in user-chip.css', () => {
  const bad = [];
  for (const f of walk(join(REPO_ROOT, 'public', 'css'), '.css')) {
    if (rel(f) === CHIP_CSS) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\.user-chip(?:__[\w-]+|--self)\b/g)) {
      bad.push(`${rel(f)}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(bad, [], `Chip-Innenteile ausserhalb von ${CHIP_CSS} gestylt:\n  ${bad.join('\n  ')}`);
});
