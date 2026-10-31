// Gate fuer den Abschnitts-Titel (DESIGN.md „Karten-Innenraum", public/css/CLAUDE.md):
// die gesperrte Caps-Zeile ueber einem Abschnitt heisst ausschliesslich
// `.card-section-title` — in Karten wie in Leseansichten (Review, Lektorat,
// Figuren-Detail). Labels im Fliesstext tragen zusaetzlich `--inline`.
//
// Geprueft wird:
//   1. Ausserhalb von card-blocks.css setzt kein CSS Schrift-/Farb-Optik auf
//      den Titel — Abweichungen tragen nur Abstand/Layout/Deko.
//   2. Keine zweite Klasse `…-section-title` fuer dieselbe Rolle (HTML, JS, CSS).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PUBLIC_DIR = join(REPO_ROOT, 'public');
const CSS_DIR = join(PUBLIC_DIR, 'css');
const OWNER_CSS = 'public/css/components/card-form/card-blocks.css';
const rel = (p) => relative(REPO_ROOT, p);

const BASE = 'card-section-title';
const ALLOWED = new Set([BASE, `${BASE}--inline`]);
const LOOK_PROPS = /^(color|font-size|font-style|font-weight|font-family|text-transform|letter-spacing)$/;

function walk(dir, exts, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'vendor' || entry === 'fonts') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

test('Optik des Abschnitts-Titels nur in card-blocks.css', () => {
  const bad = [];
  for (const file of walk(CSS_DIR, ['.css'])) {
    if (rel(file) === OWNER_CSS) continue;
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim();
      const last = selector.split(',').map((s) => s.trim().split(/[\s>+~]+/).pop());
      // Pseudo-Elemente (::before-Tick) sind Deko, nicht die Titelschrift.
      if (!last.some((sel) => sel.includes(`.${BASE}`) && !sel.includes('::'))) continue;
      for (const decl of m[2].split(';')) {
        const prop = decl.split(':')[0].trim();
        if (LOOK_PROPS.test(prop)) {
          const at = m.index + m[1].length - m[1].trimStart().length;
          bad.push(`${rel(file)}:${lineOf(src, at)}  ${selector} { ${decl.trim()} }`);
        }
      }
    }
  }
  assert.deepEqual(bad, [],
    `Die Schrift des Abschnitts-Titels kommt aus ${OWNER_CSS} — Feature-CSS traegt nur ` +
    'Abstand/Layout:\n' + bad.join('\n'));
});

test('Kein zweiter Abschnitts-Titel neben card-section-title', () => {
  const bad = [];
  for (const file of walk(PUBLIC_DIR, ['.html', '.js', '.css'])) {
    if (rel(file) === 'public/sw-manifest.js') continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?<![\w-])\.?([a-z][\w-]*-section-title[\w-]*)/g)) {
      if (!ALLOWED.has(m[1])) bad.push(`${rel(file)}:${lineOf(src, m.index)}  ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `Abschnitts-Titel nur als \`${BASE}\` (+ \`--inline\`):\n` + bad.join('\n'));
});
