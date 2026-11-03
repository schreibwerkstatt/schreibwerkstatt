// Gate fuer die Auswahl-Leiste (DESIGN.md „Auswahl-Leiste",
// public/js/selection-bar.js, components/selection-bar.css): Sammelaktionen
// ueber markierte Zeilen haben EINE Mechanik und EINE Optik.
//
// Geprueft wird:
//   1. `.selection-bar*` wird nur in selection-bar.css gestylt (plus die
//      geteilte Compact-Regel fuers Textfeld in card-blocks.css).
//   2. Die Auswahl-Methoden werden nur in selection-bar.js definiert — eine
//      Karte liefert `selectionVisibleIds()`, baut aber kein eigenes Set nach.
//   3. Jede `.selection-bar` im Markup ist eine Toolbar mit :aria-label und
//      zaehlt ueber `selectionCount()`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

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

const CSS_OWNERS = new Set([
  'public/css/components/selection-bar.css',
  'public/css/components/card-form/card-blocks.css',
]);

test('.selection-bar wird nur in selection-bar.css gestylt', () => {
  const bad = walk(join(ROOT, 'public/css'), '.css')
    .filter(f => !CSS_OWNERS.has(rel(f)))
    .filter(f => /\.selection-bar\b/.test(readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')))
    .map(rel);
  assert.deepEqual(bad, [], 'eigenes Styling der Auswahl-Leiste — gehoert nach components/selection-bar.css');
});

test('Auswahl-Methoden nur aus selection-bar.js', () => {
  const re = /^\s*(isSelected|toggleSelect|clearSelection|selectedVisibleIds|selectionCount|allVisibleSelected|toggleSelectAllVisible|_pruneSelection)\s*\(/m;
  const bad = walk(join(ROOT, 'public/js'), '.js')
    .filter(f => rel(f) !== 'public/js/selection-bar.js')
    .filter(f => re.test(readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(bad, [], 'Auswahl-Mechanik nachgebaut — selectionMethods spreaden, nur selectionVisibleIds() liefern');
});

test('jede .selection-bar ist Toolbar mit Namen und zaehlt ueber selectionCount()', () => {
  const files = [...walk(join(ROOT, 'public/partials'), '.html'), join(ROOT, 'public/index.html')];
  let seen = 0;
  const bad = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/<div class="selection-bar"[^>]*>/g)) {
      seen++;
      const tag = m[0];
      if (!/role="toolbar"/.test(tag) || !/:aria-label=/.test(tag)) bad.push(`${rel(f)}: role="toolbar" + :aria-label fehlt`);
      const body = src.slice(m.index, m.index + 4000);
      if (!/selectionCount\(\)/.test(body)) bad.push(`${rel(f)}: Zaehler nicht ueber selectionCount()`);
    }
  }
  assert.ok(seen >= 2, 'Konsumenten nicht gefunden — Gate pruefen');
  assert.deepEqual(bad, []);
});
