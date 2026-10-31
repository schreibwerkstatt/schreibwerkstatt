// Layer-Gate (DESIGN.md „CSS-File-Inventar" → „Zwei Regeln, die jede Datei
// betreffen", Regel 1): jede CSS-Datei legt ihre Regeln in einen Cascade-Layer.
//
// WARUM: tokens.css etabliert `@layer base, components, utilities`. Unlayerte
// Regeln schlagen jeden Layer, unabhaengig von der Spezifitaet — eine Datei ohne
// Layer gewinnt still gegen jede layered Komponentenregel, und der Fehler faellt
// erst auf, wenn ein gezielter Override nicht greift.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const CSS_DIR = join(ROOT, 'public', 'css');

// Die dokumentierten Ausnahmen (DESIGN.md, Tabelle „Unlayered") — Pfad-Praefixe.
const UNLAYERED = [
  'css/tokens/',          // Custom-Properties sind global
  'css/tokens.css',       // Facade: Layer-Order, @font-face, @import
  'css/share.css',        // Reader gewinnt ueber den Layer-Rang
  'css/share/',
  'css/entities/orte-map.css', // Leaflet-CSS haengt zur Laufzeit unlayered dahinter
  'css/entities/figur-werkstatt.css', // ueberschreibt vendor/jsmind-*.css (unlayered)
  'css/landing.css',      // Standalone-Seiten (Landing/Register/Datenschutz) ohne SPA-Komponenten
];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'vendor') continue;
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (e.endsWith('.css')) out.push(f);
  }
  return out;
}

// Jede Regel muss innerhalb eines `@layer <name> { … }` stehen. Geprueft wird
// auf oberster Ebene: ausserhalb eines Layer-Blocks darf nur Kommentar/Whitespace
// stehen.
export function topLevelOutsideLayer(src) {
  const css = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const stray = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    const prelude = (open < 0 ? css.slice(i) : css.slice(i, open)).trim();
    if (open < 0) { if (prelude) stray.push(prelude); break; }
    let depth = 1, j = open + 1;
    while (depth && j < css.length) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    if (!/^@layer\s+[\w-]+$/.test(prelude)) stray.push(prelude.split('\n').pop().slice(0, 80));
    i = j;
  }
  return stray;
}

test('jede CSS-Datei liegt in einem @layer (ausser den dokumentierten Ausnahmen)', () => {
  const fails = [];
  for (const f of walk(CSS_DIR)) {
    const r = relative(join(ROOT, 'public'), f).split('\\').join('/');
    if (UNLAYERED.some((u) => r.startsWith(u))) continue;
    const stray = topLevelOutsideLayer(readFileSync(f, 'utf8'));
    if (stray.length) fails.push(`${r}: Regel ausserhalb von @layer — „${stray[0]}"`);
  }
  for (const u of UNLAYERED) {
    if (!existsSync(join(ROOT, 'public', u))) fails.push(`Ausnahme verweist auf geloeschten Pfad: ${u}`);
  }
  assert.equal(fails.length, 0, `Unlayerte CSS-Regeln:\n  ${fails.join('\n  ')}`);
});
