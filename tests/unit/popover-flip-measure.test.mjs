// Tripwire: JS-positionierte Flip-up-Popover muessen ihre echte Hoehe messen.
//
// Muster der nach <body> teleportierten Kebab-/Context-Menues (Ideen, Plot-Lane,
// Spellcheck-Form-Popover): passt unterhalb des Triggers kein Platz mehr, klappen
// sie nach oben und positionieren sich via `anchor.top - hoehe - n`. Wird `hoehe`
// als fixe Konstante geraten (z.B. `const PH = 240`), loest sich das Menue beim
// Hochklappen vom Button — es schwebt mit einer Luecke darueber, weil die echte
// Popover-Hoehe kleiner ist als die Schaetzung.
//
// Regel: Wer downward-overflow gegen window.innerHeight prueft UND sich oberhalb
// des Ankers per Hoehen-Subtraktion neu positioniert, MUSS die echte Groesse des
// Popovers messen — `el.offsetHeight` (nach $nextTick) oder `getBoundingClientRect()`
// → `.height`. Prosa-Regel = Vorschlag, Test = Gesetz. Neuer Verstoss → CI rot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const JS_DIR = join(REPO_ROOT, 'public', 'js');
const rel = (p) => relative(REPO_ROOT, p);

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'vendor') continue;
      walk(full, ext, out);
    } else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

// (a) Downward-Fit-Test: ein `bottom + …`-Term, der gegen window.innerHeight prueft.
const OVERFLOW_RE = /\bbottom\b\s*\+[^>\n;]*>\s*window\.innerHeight/;
// (b) Reposition oberhalb des Ankers per Hoehen-Subtraktion: `.top … - <h> - <n>`.
const ABOVE_RE = /\.top\b[^=\n;]*-\s*[\w.]+\s*-\s*\d+/;
// Mess-Beleg: echte Popover-Groesse statt geratener Konstante.
const MEASURE_RE = /offsetHeight|\.height\b/;

test('flip-up popovers measure their real height (no guessed PH constant)', () => {
  const violations = [];
  for (const file of walk(JS_DIR, '.js')) {
    const src = readFileSync(file, 'utf8');
    const isFlipPositioner = OVERFLOW_RE.test(src) && ABOVE_RE.test(src);
    if (isFlipPositioner && !MEASURE_RE.test(src)) {
      const line = src.split('\n').findIndex((l) => /\.top\b[^=\n;]*-\s*[\w.]+\s*-\s*\d+/.test(l)) + 1;
      violations.push(`${rel(file)}:${line}: klappt oben auf, misst aber keine echte Popover-Hoehe`);
    }
  }
  assert.equal(
    violations.length,
    0,
    'Flip-up-Popover mit geratener Hoehe — Menue loest sich beim Hochklappen vom Trigger.\n' +
      'Fix: nach $nextTick die echte Groesse messen (el.offsetHeight / getBoundingClientRect().height)\n' +
      'und damit neu positionieren. Referenz: public/js/action-menu.js#_remeasureActionMenu.\n  ' +
      violations.join('\n  '),
  );
});
