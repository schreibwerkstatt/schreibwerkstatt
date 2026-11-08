// Gate gegen Ruckeln in horizontal scrollenden Boards (public/css/CLAUDE.md
// „Horizontal scrollende Boards ruckelfrei").
//
// Geprueft wird:
//   1. Kein `scroll-snap-type` in public/css. Der Snap korrigiert die Position
//      nach dem Trackpad-Scroll sichtbar nach (Sprung auf den Spaltenanfang) —
//      das liest sich als Ruckeln.
//   2. Jede Hover-Regel mit Lift (`transform: translateY(-…)`) hat in derselben
//      Datei eine Gegenregel `.<container>.is-scrolling .<karte>:hover` mit
//      `transform: none` — sonst hebt und senkt sich jede Karte, die beim Scrollen
//      unter dem stehenden Cursor durchgleitet.
//   3. Jeder solche Container bindet im Markup den Scroll-Zustand
//      (`_bindScrollFade($el…)`, public/js/scroll-fade.js) — ohne ihn wird
//      `.is-scrolling` nie gesetzt und die Gegenregel ist tot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const CSS_DIR = join(REPO_ROOT, 'public', 'css');
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const INDEX_HTML = join(REPO_ROOT, 'public', 'index.html');

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}
const rel = (p) => relative(REPO_ROOT, p);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

// Innerste Regeln (Selektor + Block ohne verschachtelte Klammern) — @layer/@media
// fallen als Wrapper weg, ihre Kinder werden einzeln gefunden.
function rules(src) {
  const out = [];
  for (const m of stripComments(src).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selectors: m[1].split(',').map(s => s.trim().replace(/\s+/g, ' ')), body: m[2] });
  }
  return out;
}

const cssFiles = walk(CSS_DIR, '.css');

test('kein scroll-snap-type in public/css', () => {
  const hits = [];
  for (const file of cssFiles) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/scroll-snap-type\s*:\s*([^;}]+)/g)) {
      if (m[1].trim() !== 'none') hits.push(`${rel(file)}: scroll-snap-type: ${m[1].trim()}`);
    }
  }
  assert.deepEqual(hits, [], `scroll-snap laesst H-Scroll nachspringen:\n  ${hits.join('\n  ')}`);
});

// Lift-Karten je Datei: Klasse der Karte → { file, containers: Set }
function liftCards() {
  const cards = [];
  for (const file of cssFiles) {
    const rs = rules(readFileSync(file, 'utf8'));
    const lifted = new Set();
    for (const r of rs) {
      if (!/transform\s*:\s*[^;]*translateY\(\s*-/.test(r.body)) continue;
      for (const sel of r.selectors) {
        const m = sel.match(/^\.([\w-]+):hover$/);
        if (m) lifted.add(m[1]);
      }
    }
    for (const card of lifted) {
      const containers = new Set();
      const re = new RegExp(`^\\.([\\w-]+)\\.is-scrolling \\.${card}:hover$`);
      for (const r of rs) {
        if (!/transform\s*:\s*none/.test(r.body)) continue;
        for (const sel of r.selectors) {
          const m = sel.match(re);
          if (m) containers.add(m[1]);
        }
      }
      cards.push({ file: rel(file), card, containers });
    }
  }
  return cards;
}

test('Hover-Lift hat eine .is-scrolling-Gegenregel', () => {
  const cards = liftCards();
  assert.ok(cards.length > 0, 'Selbsttest: keine Lift-Karte gefunden — Regex veraltet?');
  const missing = cards.filter(c => c.containers.size === 0).map(c => `${c.file}: .${c.card}:hover`);
  assert.deepEqual(missing, [],
    `Hover-Lift ohne Gegenregel \`.<container>.is-scrolling .<karte>:hover { transform: none; box-shadow: none; transition: none; }\`:\n  ${missing.join('\n  ')}`);
});

test('Container der Gegenregel bindet den Scroll-Zustand im Markup', () => {
  const markup = [...walk(PARTIALS_DIR, '.html'), INDEX_HTML].map(f => readFileSync(f, 'utf8')).join('\n');
  const tags = [...markup.matchAll(/<\w+\b[^>]*>/g)].map(m => m[0]);
  const missing = [];
  for (const { file, containers } of liftCards()) {
    for (const c of containers) {
      const bound = tags.some(t => new RegExp(`class="[^"]*\\b${c}\\b[^"]*"`).test(t) && /_bindScrollFade\(\$el/.test(t));
      if (!bound) missing.push(`${file}: .${c} ohne x-init="$app._bindScrollFade($el, { idleMs: 200 })"`);
    }
  }
  assert.deepEqual(missing, [], `.is-scrolling wird nie gesetzt:\n  ${missing.join('\n  ')}`);
});
