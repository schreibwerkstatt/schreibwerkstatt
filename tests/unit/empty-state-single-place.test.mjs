// Gate fuer den Leerzustand (DESIGN.md „Leerzustand", public/CLAUDE.md):
// „hier ist (noch) nichts" hat zwei Bausteine und sonst keinen.
//   - `.card-empty` (+ `-text`/`-hint`/`-cta`/`-actions`, `--compact`):
//     Einstieg mit Knopf oder Erklaerung, wenn eine Karte/ein Panel leer ist.
//   - `.muted-msg` (`--sm`/`--block`): reiner Text an der Stelle einer leeren
//     Liste, Spalte oder eines leeren Popovers.
// Eine Feature-Klasse daneben (`organizer-empty`, `kapitel-empty-hint`) ist
// nur Anker fuer die Abweichung (Abstand, Ausrichtung) — nie fuer die Optik.
//
// Geprueft wird:
//   1. Jedes Element mit einer Leer-Klasse (`…-empty`, `…__…-empty`,
//      `…-empty-…`) traegt zusaetzlich `card-empty` oder `muted-msg`.
//   2. Feature-CSS auf einer Leer-Klasse setzt keine Schrift-/Farb-Optik
//      (`color`, `font-size`, `font-style`, `font-weight`).
//   3. Die Teile `card-empty-text/-hint/-cta/-actions` stehen nur in Dateien,
//      die auch einen `card-empty`-Container haben.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const INDEX_HTML = join(REPO_ROOT, 'public', 'index.html');
const CSS_DIR = join(REPO_ROOT, 'public', 'css');
const rel = (p) => relative(REPO_ROOT, p);

// Klassen, die „-empty" tragen, aber einen Zustand eines anderen Bausteins
// markieren, keine Leer-Meldung sind.
const NOT_A_MESSAGE = new Map([
  ['tok-empty', 'Token-Badge eines leeren Abschnitts (Badge-Zustand, keine Meldung)'],
  ['figur-cv-cell-empty', 'leere Zelle im Lebenslauf-Raster (Zellzustand, keine Meldung)'],
  ['diff-empty-mark', 'Diff-Marker im Revisions-Viewer (Markierung, keine Meldung)'],
]);

// Leerzeilen, die ein anderer Baustein selbst rendert und stylt.
const OWN_COMPONENT = new Map([
  ['combobox-empty', 'Innenleben der Pflicht-Komponente combobox (JS-gerendert)'],
  ['lt-popover__empty', 'Spellcheck-Popover im OTA-Editor-Bundle — die nativen Schalen laden card-blocks.css nicht'],
]);
// Share-Reader: eigene SSR-Seite mit eigenem Theme (`--share-*`), ohne card-blocks.css.
const SKIP_CSS_DIRS = ['public/css/share/'];

const GENERIC = new Set(['card-empty', 'muted-msg']);
const LOOK_PROPS = /^(color|font-size|font-style|font-weight)$/;

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

function isEmptyMarker(cls) {
  if (cls.startsWith('card-empty') || cls.includes('--') || cls === 'is-empty') return false;
  if (NOT_A_MESSAGE.has(cls) || OWN_COMPONENT.has(cls)) return false;
  return /(?:-|__)empty(?:-[a-z]+)*$/.test(cls);
}

const htmlFiles = () => [...walk(PARTIALS_DIR, '.html'), INDEX_HTML];

test('Leer-Klassen stehen nur neben card-empty oder muted-msg', () => {
  const bad = [];
  const re = /<\w+\b[^>]*?\bclass="([^"]*)"/gs;
  for (const file of htmlFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const classes = m[1].split(/\s+/).filter(Boolean);
      const markers = classes.filter(isEmptyMarker);
      if (!markers.length) continue;
      if (classes.some((c) => GENERIC.has(c))) continue;
      const line = src.slice(0, m.index).split('\n').length;
      bad.push(`${rel(file)}:${line}  class="${m[1]}"`);
    }
  }
  assert.deepEqual(bad, [],
    'Leerzustand ohne Baustein — `card-empty` (Einstieg mit Knopf/Erklaerung) oder ' +
    '`muted-msg muted-msg--sm` (reiner Text) dazusetzen:\n' + bad.join('\n'));
});

test('Feature-CSS einer Leer-Klasse traegt keine Schrift-/Farb-Optik', () => {
  const bad = [];
  for (const file of walk(CSS_DIR, '.css')) {
    if (SKIP_CSS_DIRS.some((d) => rel(file).startsWith(d))) continue;
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim();
      const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
      // Nur Regeln, deren letztes Glied (das gestylte Element) eine Leer-Klasse ist.
      const last = selector.split(',').map((s) => s.trim().split(/[\s>+~]+/).pop());
      if (!last.some((sel) => [...sel.matchAll(/\.([\w-]+)/g)].some((x) => isEmptyMarker(x[1])))) continue;
      if (!classes.length) continue;
      for (const decl of m[2].split(';')) {
        const prop = decl.split(':')[0].trim();
        if (LOOK_PROPS.test(prop)) {
          const at = m.index + m[1].length - m[1].trimStart().length;
          const line = src.slice(0, at).split('\n').length;
          bad.push(`${rel(file)}:${line}  ${selector} { ${decl.trim()} }`);
        }
      }
    }
  }
  assert.deepEqual(bad, [],
    'Die Optik des Leerzustands kommt aus `.muted-msg`/`.card-empty*` — die Feature-Klasse ' +
    'traegt nur Abstand/Ausrichtung:\n' + bad.join('\n'));
});

test('card-empty-Teile nur zusammen mit einem card-empty-Container', () => {
  const bad = [];
  for (const file of htmlFiles()) {
    const src = readFileSync(file, 'utf8');
    const classes = new Set([...src.matchAll(/\bclass="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)));
    const parts = [...classes].filter((c) => /^card-empty-(text|hint|cta|actions)$/.test(c));
    if (parts.length && !classes.has('card-empty')) bad.push(`${rel(file)}: ${parts.join(', ')}`);
  }
  assert.deepEqual(bad, [], 'card-empty-Teile ausserhalb eines `.card-empty`:\n' + bad.join('\n'));
});
