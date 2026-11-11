// Gate fuer die Schlagwort-Eingabe (DESIGN.md „Schlagwort-Eingabe",
// public/js/tag-input.js, components/tag-input.css): ein Formular, das freie
// Schlagworte an einem Objekt setzt, nutzt EINEN Kern und EINE Optik.
//
// Geprueft wird:
//   1. `.tag-input*` wird nur in tag-input.css gestylt.
//   2. Kein Formular baut die Eingabe nach: keine Chip-Reihe mit Entfernen-
//      Knopf neben einem Textfeld, das per Enter/Komma Schlagworte uebernimmt
//      (Signal: `@keydown` auf einem Feld, dessen Methode Tag/Schlagwort heisst),
//      und kein Komma-Textfeld fuer Tags im Formular eines Objekts.
//   3. Jede Verwendung koppelt per `x-modelable="tags"` an ein Draft-Feld und
//      liefert den Pool per `x-effect="pool = …"`.
// Dazu Verhalten des Kerns (Normalisierung, Vorschlaege).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { normalizeTags, tagSuggestions } from '../../public/js/tag-input.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const rel = (f) => relative(ROOT, f);

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { if (entry !== 'vendor') walk(full, ext, out); }
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const partials = () => [...walk(join(ROOT, 'public/partials'), '.html'), join(ROOT, 'public/index.html')];

test('.tag-input wird nur in tag-input.css gestylt', () => {
  const bad = walk(join(ROOT, 'public/css'), '.css')
    .filter(f => rel(f) !== 'public/css/components/tag-input.css')
    .filter(f => /\.tag-input\b/.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')))
    .map(rel);
  assert.deepEqual(bad, [], 'eigenes Styling der Schlagwort-Eingabe — gehoert nach components/tag-input.css');
});

test('keine nachgebaute Schlagwort-Eingabe im Markup', () => {
  const bad = [];
  for (const f of partials()) {
    const src = readFileSync(f, 'utf8');
    if (/@keydown="on\w*Tag\w*Keydown/i.test(src)) bad.push(`${rel(f)}: eigener Tag-Keydown-Handler`);
    // Ein Formular-Feld, das Tags als Kommaliste in ein Draft schreibt.
    if (/x-model="(?:draft|\w+Draft)\.tags"/.test(src.replace(/x-modelable="tags" x-model="(?:draft|\w+Draft)\.tags"/g, '')))
      bad.push(`${rel(f)}: Tags als Textfeld statt tagInput`);
  }
  assert.deepEqual(bad, []);
});

test('jede Verwendung koppelt ueber x-modelable="tags" und liefert den Pool', () => {
  let seen = 0;
  const bad = [];
  for (const f of partials()) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/<div[^>]*x-data="tagInput\([^>]*>/g)) {
      seen++;
      if (!/x-modelable="tags"/.test(m[0])) bad.push(`${rel(f)}: x-modelable="tags" fehlt`);
      if (!/x-effect="pool = /.test(m[0])) bad.push(`${rel(f)}: Pool fehlt (x-effect="pool = …")`);
      if (!/:aria-labelledby=|label:/.test(m[0])) bad.push(`${rel(f)}: kein Name`);
    }
  }
  assert.ok(seen >= 2, 'Konsumenten nicht gefunden — Gate pruefen');
  assert.deepEqual(bad, []);
});

test('normalizeTags: trimmt, entdoppelt ohne Gross/Klein, deckelt', () => {
  assert.deepEqual(normalizeTags(['  Roman ', 'roman', 'A  B', '', 7, 'Archiv']), ['Roman', 'A B', 'Archiv']);
  assert.deepEqual(normalizeTags(['a', 'b', 'c'], { max: 2 }), ['a', 'b']);
  assert.deepEqual(normalizeTags(['abcdef'], { maxLen: 3 }), ['abc']);
  assert.deepEqual(normalizeTags('a,b'), []);
});

test('tagSuggestions: ohne Vorhandene, nach Eingabe gefiltert, leer am Deckel', () => {
  const pool = ['Archiv', 'Brief', 'archiv', 'Briefwechsel'];
  assert.deepEqual(tagSuggestions(pool, ['brief'], ''), ['Archiv', 'Briefwechsel']);
  assert.deepEqual(tagSuggestions(pool, [], 'brie'), ['Brief', 'Briefwechsel']);
  assert.deepEqual(tagSuggestions(pool, ['x', 'y'], '', { max: 2 }), []);
});
