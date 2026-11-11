// Kein :has() an der Dokumentwurzel (public/css/CLAUDE.md).
//
// WARUM: globaler Zustand gehört dem Code, der ihn schaltet — als Klasse
// (`body.focus-mode`, `html.revision-viewer-open`) ist er dort sichtbar und
// auffindbar, und die nativen Schalen können dieselbe Klasse setzen. Ein
// `:root:has(x)` koppelt eine globale Regel still an ein DOM-Detail. Eine
// Performance-Regel ist das nicht: gemessen kosteten Wurzel-:has() im
// Notebook-Editor unter 0,5 ms Stil-Arbeit je Taste.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const CSS_DIR = join(ROOT, 'public', 'css');

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'vendor') continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (e.endsWith('.css')) out.push(f);
  }
  return out;
}

// Wurzel-Element direkt vor `:has(` — auch mit Klassen/Attributen dazwischen
// (`html.foo:has(…)`, `:root[data-x]:has(…)`).
const ROOT_HAS = /(?:^|[\s,{>~+(])(?::root|html|body)(?:[.#\[:][\w\-\]="'.:]*?)?:has\(/m;

test('keine CSS-Regel hängt :has() an :root, html oder body', () => {
  const hits = [];
  for (const f of walk(CSS_DIR)) {
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    src.split('\n').forEach((line, i) => {
      if (ROOT_HAS.test(line)) hits.push(`${relative(ROOT, f)}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], 'Wurzel-:has() gefunden — Zustand als Klasse setzen:\n' + hits.join('\n'));
});

test('Muster erkennt die Varianten', () => {
  for (const s of [':root:has(.a) .b {', 'html:has(.x[open]) {', 'body:has(.y) {', 'html.dark:has(.z) {', '.a, :root:has(.b) {'])
    assert.ok(ROOT_HAS.test(s), s);
  for (const s of ['.card-header:has(.x) {', '.page-content-view p:has(.m) {', ':root :is(.a) {', 'body.focus-mode .b {'])
    assert.ok(!ROOT_HAS.test(s), s);
});
