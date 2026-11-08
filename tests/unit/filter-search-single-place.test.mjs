// Gate fuer das Listen-Suchfeld (DESIGN.md „Filter-Bar", CSS-SSoT
// components/card-form/card-blocks.css): jedes Suchfeld, das eine Liste
// filtert, sieht gleich aus und hat dasselbe Loesch-X.
//
// Geprueft wird im Markup (public/partials + index.html):
//   1. `.filter-search-input` steht nur in einer `.filter-bar` (Leiste) oder
//      `.selection-bar` (Sammel-Eingabe) — ausserhalb greift keine seiner
//      Regeln, das Feld faellt auf die volle Formular-Optik zurueck.
//   2. In der `.filter-bar` sitzt es direkt in einem `.filter-search-wrap`, und
//      der Wrapper traegt das Loesch-X (`.search-clear--icon`) — ohne Wrapper
//      verankert sich das absolut positionierte X am falschen Vorfahren.
//   3. Es ist `type="text"`; `type="search"` gibt es nur fuer die globale Suche
//      (`.search-q`, eigenes Muster in search.css) — sonst zeichnet der Browser
//      ein zweites, eigenes X neben unseres.
// Und im CSS:
//   4. Ausserhalb von card-blocks.css darf eine Regel auf `.filter-search-input`
//      nur Breite/Flex setzen, nie Optik (Schrift, Rand, Polster, Farbe).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const INDEX_HTML = join(REPO_ROOT, 'public', 'index.html');
const CSS_DIR = join(REPO_ROOT, 'public', 'css');
const OWNER_CSS = 'public/css/components/card-form/card-blocks.css';

const LAYOUT_PROPS = new Set(['width', 'min-width', 'max-width', 'flex', 'flex-grow', 'flex-shrink', 'flex-basis']);
const SEARCH_TYPE_ALLOWED = new Set(['search-q']);
const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'wbr', 'col', 'area', 'base', 'embed', 'param', 'track']);

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const rel = (p) => relative(REPO_ROOT, p);
const classesOf = (attrs) => (attrs.match(/(?:^|\s)class="([^"]*)"/)?.[1] || '').split(/\s+/).filter(Boolean);

// Baut einen flachen Elementbaum: jedes Element kennt Tag, Klassen, Attribute,
// Eltern und Kinder. Kommentare werden uebersprungen; Attributwerte duerfen `>`
// enthalten (Alpine-Ausdruecke).
function parse(src) {
  const root = { tag: '#root', classes: [], attrs: '', children: [], parent: null };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  for (const m of src.matchAll(re)) {
    if (!m[2]) continue;
    const [, closing, rawTag, attrs] = m;
    const tag = rawTag.toLowerCase();
    if (closing) {
      const idx = stack.map(e => e.tag).lastIndexOf(tag);
      if (idx > 0) stack.length = idx;
      continue;
    }
    const parent = stack[stack.length - 1];
    const el = { tag, classes: classesOf(attrs), attrs, children: [], parent,
      line: src.slice(0, m.index).split('\n').length };
    parent.children.push(el);
    if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) stack.push(el);
  }
  return root;
}

function* elements(node) {
  for (const c of node.children) { yield c; yield* elements(c); }
}
const ancestors = function* (el) { for (let p = el.parent; p; p = p.parent) yield p; };

function markupFiles() {
  return [...walk(PARTIALS_DIR, '.html'), INDEX_HTML].map(f => ({ file: rel(f), tree: parse(readFileSync(f, 'utf8')) }));
}

test('filter-search-input steht nur in einer .filter-bar oder .selection-bar', () => {
  const bad = [];
  for (const { file, tree } of markupFiles()) {
    for (const el of elements(tree)) {
      if (!el.classes.includes('filter-search-input')) continue;
      const host = [...ancestors(el)].some(a => a.classes.includes('filter-bar') || a.classes.includes('selection-bar'));
      if (!host) bad.push(`${file}:${el.line}`);
    }
  }
  assert.deepEqual(bad, [], `Suchfeld ausserhalb einer Leiste — in <div class="filter-bar"> setzen (DESIGN.md „Filter-Bar"):\n  ${bad.join('\n  ')}`);
});

test('in der .filter-bar sitzt das Suchfeld im .filter-search-wrap mit Loesch-X', () => {
  const bad = [];
  for (const { file, tree } of markupFiles()) {
    for (const el of elements(tree)) {
      if (!el.classes.includes('filter-search-input')) continue;
      const host = [...ancestors(el)].find(a => a.classes.includes('filter-bar') || a.classes.includes('selection-bar'));
      if (!host?.classes.includes('filter-bar')) continue;
      const wrap = el.parent;
      if (!wrap.classes.includes('filter-search-wrap')) {
        bad.push(`${file}:${el.line} — Eltern ist <${wrap.tag}>, nicht .filter-search-wrap`);
        continue;
      }
      const hasClear = [...elements(wrap)].some(c => c.classes.includes('search-clear--icon'));
      if (!hasClear) bad.push(`${file}:${el.line} — .filter-search-wrap ohne .search-clear--icon`);
    }
  }
  assert.deepEqual(bad, [], `Suchfeld nicht im Standard-Markup (DESIGN.md „Filter-Bar"):\n  ${bad.join('\n  ')}`);
});

test('Suchfelder sind type="text"; type="search" nur fuer die globale Suche', () => {
  const bad = [];
  for (const { file, tree } of markupFiles()) {
    for (const el of elements(tree)) {
      if (el.tag !== 'input') continue;
      const type = el.attrs.match(/(?:^|\s)type="([^"]*)"/)?.[1] || 'text';
      if (el.classes.includes('filter-search-input') && type !== 'text') {
        bad.push(`${file}:${el.line} — .filter-search-input mit type="${type}"`);
      } else if (type === 'search' && !el.classes.some(c => SEARCH_TYPE_ALLOWED.has(c))) {
        bad.push(`${file}:${el.line} — type="search" ausserhalb der globalen Suche`);
      }
    }
  }
  assert.deepEqual(bad, [], `Natives Such-Feld — als .filter-search-input mit type="text" bauen:\n  ${bad.join('\n  ')}`);
});

test('Feature-CSS setzt am Suchfeld nur Breite/Flex, nie Optik', () => {
  const bad = [];
  for (const file of walk(CSS_DIR, '.css')) {
    const r = rel(file);
    if (r === OWNER_CSS) continue;
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].split(',').map(s => s.trim()).filter(s => /\.filter-search-input(?![\w-])\s*(:[\w-]+)?$/.test(s));
      if (!sel.length) continue;
      const props = m[2].split(';').map(d => d.split(':')[0].trim()).filter(Boolean);
      const off = props.filter(p => !LAYOUT_PROPS.has(p));
      if (off.length) bad.push(`${r}: ${sel.join(', ')} { ${off.join(', ')} }`);
    }
  }
  assert.deepEqual(bad, [], `Optik des Suchfelds gehoert nach ${OWNER_CSS}:\n  ${bad.join('\n  ')}`);
});
