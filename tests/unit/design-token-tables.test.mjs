// Drift-Gate: die Token-Tabellen in DESIGN.md spiegeln public/css/tokens/*.css.
//
// WARUM: DESIGN.md ist der Katalog, nach dem neue UI gebaut wird. Stand dort
// `--z-toolbar` (1100) unter `--z-overlay`, waehrend die Datei 2100 trug, baute
// die naechste Komponente gegen einen Stapel, den es nicht gibt. Geprueft werden
// die Zeilen „Z-Index", „Radius", „Font-Size" der Token-Tabelle und die
// Tabelle im Abschnitt „Z-Index-Stack": gleiche Token-Menge, gleiche Werte.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const DESIGN = readFileSync(join(ROOT, 'DESIGN.md'), 'utf8');

function tokens(file, prefix) {
  const src = readFileSync(join(ROOT, 'public', 'css', 'tokens', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map();
  for (const m of src.matchAll(new RegExp(`(${prefix}[\\w-]*)\\s*:\\s*([^;]+);`, 'g'))) out.set(m[1], m[2].trim());
  return out;
}

// `| **Name** | `--a` (1), `--b` (2px — …) | … |` → Map(token → erster Wert)
function summaryRow(name) {
  const line = DESIGN.split('\n').find((l) => l.startsWith(`| **${name}** |`));
  assert.ok(line, `DESIGN.md: Token-Zeile „${name}" fehlt`);
  const cell = line.split('|')[2];
  const out = new Map();
  for (const m of cell.matchAll(/`(--[\w-]+)`\s*\(([^)\s,—]+)/g)) out.set(m[1], m[2]);
  return out;
}

const norm = (v) => (v === '0' || v === '0px' ? '0' : v);

function compare(label, doc, css) {
  const fails = [];
  for (const [k, v] of css) {
    if (!doc.has(k)) fails.push(`${label}: ${k} (${v}) fehlt in DESIGN.md`);
    else if (norm(doc.get(k)) !== norm(v)) fails.push(`${label}: ${k} DESIGN.md ${doc.get(k)} ≠ CSS ${v}`);
  }
  for (const k of doc.keys()) if (!css.has(k)) fails.push(`${label}: ${k} steht in DESIGN.md, existiert aber nicht in tokens/`);
  return fails;
}

test('DESIGN.md-Token-Tabellen = tokens/*.css (Z-Index, Radius, Font-Size)', () => {
  const z = tokens('scale.css', '--z-');
  const radius = tokens('spacing.css', '--radius-');
  const fontSize = tokens('typography.css', '--font-size-');

  // Tabelle im Abschnitt „Z-Index-Stack": `| `--z-x` | 100 | … |`
  const sec = DESIGN.slice(DESIGN.indexOf('## Z-Index-Stack'));
  const stackEnd = sec.indexOf('\n## ', 5);
  const stack = new Map();
  for (const m of sec.slice(0, stackEnd).matchAll(/^\| `(--z-[\w-]+)` \| (\d+) \|/gm)) stack.set(m[1], m[2]);

  const fails = [
    ...compare('Z-Index (Token-Tabelle)', summaryRow('Z-Index'), z),
    ...compare('Z-Index-Stack', stack, z),
    ...compare('Radius', summaryRow('Radius'), radius),
    ...compare('Font-Size', summaryRow('Font-Size'), fontSize),
  ];
  // Reihenfolge im Stack = numerisch aufsteigend (die Tabelle ist ein Stapel).
  const vals = [...stack.values()].map(Number);
  if (vals.some((v, i) => i && v < vals[i - 1])) fails.push('Z-Index-Stack: Zeilen nicht aufsteigend sortiert');
  assert.equal(fails.length, 0, `DESIGN.md driftet von tokens/:\n  ${fails.join('\n  ')}`);
});
