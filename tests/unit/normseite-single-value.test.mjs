// Normseite: ein Wert für App, Exposé und /metrics. Browser rechnet über
// utils/format.js#CHARS_PER_NORMSEITE, der Server über lib/normseite.js — beide
// Konstanten müssen gleich sein, und niemand teilt Zeichen an einer dritten
// Stelle durch eine Zahl, sonst zeigt die Buchentwicklung andere Normseiten
// als Home Assistant oder das Exposé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const require = createRequire(import.meta.url);
const { CHARS_PER_NORMSEITE } = await import('../../public/js/utils/format.js');
const { NORMSEITE_CHARS } = require('../../lib/normseite.js');

test('Normseite: Browser- und Server-Konstante sind gleich', () => {
  assert.equal(NORMSEITE_CHARS, CHARS_PER_NORMSEITE);
});

function* walk(dir, exts) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'vendor' && name !== 'node_modules') yield* walk(p, exts); }
    else if (exts.some(e => name.endsWith(e))) yield p;
  }
}

test('kein Zeichen-durch-Zahl-Normseiten-Teiler ausserhalb der beiden Konstanten', () => {
  const OWNERS = new Set(['public/js/utils/format.js', 'lib/normseite.js']);
  const re = /chars[^\n;]{0,40}\/\s*(1500|1800)\b/i;
  const treffer = [];
  for (const dir of ['public/js', 'public/partials', 'lib', 'routes']) {
    for (const file of walk(join(ROOT, dir), ['.js', '.html'])) {
      const rel = file.slice(ROOT.length + 1);
      if (OWNERS.has(rel)) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (re.test(line)) treffer.push(`${rel}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(treffer, [], 'Normseiten über charsToNormseiten/CHARS_PER_NORMSEITE bzw. lib/normseite.js rechnen:\n  ' + treffer.join('\n  '));
});
