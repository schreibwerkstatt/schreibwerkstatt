// Gate gegen Icon-Grössen-Drift auf Icon-only Action-/Close-Buttons.
//
// Hintergrund: <svg.icon> ist per Default 1em, skaliert also mit der font-size
// des Buttons. Die Close-/Action-Buttons der App setzen aber je eigene
// font-sizes (Card-Close 18px, Toast 16px, Find 15px, Synonym/Figur ~17.6px,
// Heatmap 13px …) → die Glyphen wären unterschiedlich gross.
// components/icon-btn.css normalisiert darum die Glyph-Grösse
// (`> .icon { width/height: var(--icon-size-action) }`).
//
// Zweite Invariante: auf Touch wachsen diese Knöpfe nicht (DESIGN.md „Touch“:
// Touch ändert das Verhalten, nicht die Grösse) — kein `@media (pointer: coarse)`
// in icon-btn.css.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const ICON_BTN_CSS = REPO_ROOT + 'public/css/components/icon-btn.css';
const TYPOGRAPHY_CSS = REPO_ROOT + 'public/css/tokens/typography.css';

// Kommentare strippen — sie enthalten selbst Klassen-artige Tokens
// (`.icon`, `.test.mjs` in Datei-Refs), die die Selektor-Extraktion vergiften.
const css = readFileSync(ICON_BTN_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Klassennamen aus einer Selektor-Liste ziehen (`.foo > .icon,` bzw. `.foo,`),
// die Glyph-Klasse `.icon` selbst rausfiltern.
function classesFromSelectorList(list) {
  return new Set(
    (list.match(/\.[a-zA-Z][\w-]*/g) || [])
      .map((s) => s.slice(1))
      .filter((c) => c !== 'icon'),
  );
}

// Block 1: die Glyph-Normalisierungs-Regel (`… > .icon { width: var(--icon-size-action) … }`)
const normMatch = css.match(/([^{}]*>\s*\.icon[^{}]*)\{\s*width:\s*var\(--icon-size-action\)/);
assert.ok(normMatch, 'Glyph-Normalisierungs-Regel mit var(--icon-size-action) fehlt in icon-btn.css');
const normClasses = classesFromSelectorList(normMatch[1]);

test('Glyph-Normalisierung umfasst die bekannten Icon-only-Buttons', () => {
  assert.ok(normClasses.size >= 10, 'Erwartet mindestens die bekannten Icon-only-Buttons in der Normalisierungs-Liste');
});

test('Symbol-Knöpfe wachsen auf Touch nicht', () => {
  assert.doesNotMatch(css, /@media[^{]*pointer:\s*coarse/, 'icon-btn.css darf auf Touch keine eigene Grösse setzen (DESIGN.md „Touch“)');
});

test('--icon-size-action Token ist definiert', () => {
  const typo = readFileSync(TYPOGRAPHY_CSS, 'utf8');
  assert.match(typo, /--icon-size-action:\s*\d+px/, '--icon-size-action muss in tokens/typography.css definiert sein');
});
