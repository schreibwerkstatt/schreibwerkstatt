// Gate fuer die Klapp-Animation der `collapsible()`-Panels (public/js/collapsible.js,
// Punkt 3): `x-collapse` animiert ausschliesslich `height`. Vertikales Padding,
// Margin oder ein Border AM Panel bleibt als Boden der Animation stehen und
// springt am Ende per `display: none` weg — sichtbares Rucken beim Auf- und
// Zuklappen. Ein eigener `height`/`max-height`-Deckel haelt die Animation fest. Ein Panel, das selbst `display: flex/grid` ist, kann den
// Formatierungskontext nicht von `.collapse-panel` (flow-root) uebernehmen.
//
// Darum: jede Klasse, die direkt am Panel-Element steht, darf in keiner CSS-Regel
// (Selektor endet auf diese Klasse) solche Deklarationen tragen. Abstaende,
// Rahmen und Layout gehoeren an ein Kind. Einzige Ausnahme ist die geteilte
// `.collapsible-section`, deren Abstaende als Spacer-Pseudoelemente in der
// animierten Hoehe liegen — deren Verlauf misst
// tests/e2e-app/collapsible-section-collapse.spec.js.
//
// Die Kontextmenues (`menu.js`) spreaden ebenfalls `x-bind="panel"`, animieren
// aber nicht per x-collapse — sie tragen `context-menu` und fallen heraus.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const INDEX_HTML = join(REPO_ROOT, 'public', 'index.html');
const CSS_DIR = join(REPO_ROOT, 'public', 'css');

const EXEMPT = new Set(['collapsible-section']);

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const rel = (p) => relative(REPO_ROOT, p);

function panelClasses() {
  const out = new Map(); // class → [fundstelle]
  for (const file of [...walk(PARTIALS_DIR, '.html'), INDEX_HTML]) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<\w+\b[^>]*\bx-bind="panel"[^>]*>/g)) {
      const cls = (m[0].match(/\bclass="([^"]*)"/) || [, ''])[1].split(/\s+/).filter(Boolean);
      if (cls.includes('context-menu')) continue;
      const line = src.slice(0, m.index).split('\n').length;
      for (const c of cls) {
        if (EXEMPT.has(c)) continue;
        if (!out.has(c)) out.set(c, []);
        out.get(c).push(`${rel(file)}:${line}`);
      }
    }
  }
  return out;
}

// Leaf-Regeln `selektor { decls }` — verschachtelte @layer/@media-Klammern
// fallen weg, weil Selektor und Body keine Klammern enthalten duerfen.
function cssRules() {
  const rules = [];
  for (const file of walk(CSS_DIR, '.css')) {
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      rules.push({ file: rel(file), selectors: m[1].split(',').map(s => s.trim()), body: m[2] });
    }
  }
  return rules;
}

const isZero = (v) => /^(0|0px|0rem|none)$/.test(v);

// Vertikale Anteile eines Box-Shorthands (padding/margin: 1–4 Werte).
function verticalParts(value) {
  const parts = value.trim().split(/\s+(?![^(]*\))/);
  if (parts.length <= 2) return [parts[0]];
  return [parts[0], parts[2]];
}

function offending(body) {
  const hits = [];
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).replace(/!important/, '').trim();
    if (prop === 'padding' || prop === 'margin') {
      if (verticalParts(value).some(v => !isZero(v))) hits.push(`${prop}: ${value}`);
    } else if (/^(padding|margin)-(top|bottom|block|block-start|block-end)$/.test(prop)) {
      if (!isZero(value)) hits.push(`${prop}: ${value}`);
    } else if (/^border(-top|-bottom|-block|-block-start|-block-end)?$/.test(prop)) {
      if (!isZero(value)) hits.push(`${prop}: ${value}`);
    } else if (prop === 'display' && /^(flex|grid|inline|inline-\w+|table)$/.test(value)) {
      hits.push(`${prop}: ${value}`);
    } else if (/^(max-height|height)$/.test(prop) && value !== 'auto' && value !== 'none') {
      // x-collapse schreibt `height` inline; ein eigener Deckel haelt die
      // Animation oben fest, bis die animierte Hoehe darunter faellt.
      hits.push(`${prop}: ${value}`);
    }
  }
  return hits;
}

test('collapsible()-Panels tragen selbst keine vertikalen Abstaende, Rahmen oder Flex/Grid', () => {
  const panels = panelClasses();
  assert.ok(panels.size > 0, 'keine Panels gefunden — Extraktion kaputt?');
  const rules = cssRules();
  const problems = [];
  for (const [cls, where] of panels) {
    const re = new RegExp(`\\.${cls}(?![\\w-])$`);
    for (const r of rules) {
      if (!r.selectors.some(s => re.test(s))) continue;
      const hits = offending(r.body);
      if (hits.length) problems.push(`.${cls} (${where.join(', ')}) — ${r.file}: ${hits.join('; ')}`);
    }
  }
  assert.equal(problems.length, 0,
    'Panel-Styling bremst die x-collapse-Animation — Abstaende/Layout an ein Kind legen ' +
    '(<div x-bind="panel" x-cloak><… class="…">…</…></div>):\n  ' + problems.join('\n  '));
});

test('collapsible-Panel-Spread setzt .collapse-panel (flow-root) und das CSS existiert', () => {
  const js = readFileSync(join(REPO_ROOT, 'public', 'js', 'collapsible.js'), 'utf8');
  assert.match(js, /\[':class'\]:\s*\(\)\s*=>\s*'collapse-panel'/);
  const css = readFileSync(join(CSS_DIR, 'entities', 'entity-list.css'), 'utf8');
  assert.match(css, /\.collapse-panel\s*\{\s*display:\s*flow-root;\s*\}/);
});
