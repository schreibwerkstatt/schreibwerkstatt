// Gate fuer das Ziehen von Karten zwischen Board-Zellen (DESIGN.md „Board-Drag",
// public/js/sortable-dnd.js#boardSortableOpts, components/board-dnd.css):
// Plot-Werkstatt, Ideen-Board und Recherche-Status ziehen gleich — dieselben
// Sortable-Optionen, derselbe Drag-Zustand, dieselbe Optik.
//
// Geprueft wird:
//   1. Jede SortableJS-Instanz in public/js laeuft ueber `boardSortableOpts` —
//      ausser den Baum-/Listen-Sortierern (TREE_SORTABLES), die keine Karten
//      zwischen Zellen ziehen.
//   2. Kein Board setzt eigene `chosenClass`/`ghostClass`/`dragClass` und keine
//      eigene <body>-Klasse fuer den Drag-Zustand.
//   3. Die Zustandsklassen `.board-dnd-*` haben nur in board-dnd.css Regeln,
//      und kein CSS kennt eine andere `*-dnd-active`-Klasse.
//   4. Jeder Container, an dem `boardSortableOpts` haengt, traegt im Markup
//      `board-dnd-zone` (sonst fehlt ihm die Drop-Zone im Drag).
//   5. Kein natives HTML5-Drag an Elementen (`draggable`, `dragstart`) — der
//      naheliegende Umweg am Kern vorbei. Ausnahme: Datei-Drop aus dem
//      Betriebssystem (file-drop.js) zieht keine Elemente der App.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const JS_DIR = join(REPO_ROOT, 'public', 'js');
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const CSS_DIR = join(REPO_ROOT, 'public', 'css');
const CORE = 'public/js/sortable-dnd.js';
const BOARD_CSS = 'public/css/components/board-dnd.css';

// Sortierer ohne Karten-Board: Buchorganizer (Kapitel-/Abschnittsbaum) und
// Motiv-Baum. Sie sortieren verschachtelte Listen, keine Zellen.
const TREE_SORTABLES = new Set([
  'public/js/book-organizer/dnd.js',
  'public/js/book/motiv/dnd.js',
]);

// Sortable-Container je Board: der Selektor, mit dem das Board seine Zellen
// sucht, und die Klasse der Zelle im Markup.
const ZONES = [
  { attr: 'data-plot-cell', cls: 'plot-beats' },
  { attr: 'data-idee-status-cell', cls: 'ideen-board-cell' },
  { attr: 'data-research-status-cell', cls: 'research-status-cell' },
];

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}
const rel = (p) => relative(REPO_ROOT, p);
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('jede Karten-Board-Sortable laeuft ueber boardSortableOpts', () => {
  const bad = [];
  for (const f of walk(JS_DIR, '.js')) {
    const r = rel(f);
    if (r === CORE || TREE_SORTABLES.has(r)) continue;
    const src = stripComments(readFileSync(f, 'utf8'));
    if (!/new Sortable\(/.test(src)) continue;
    if (!/boardSortableOpts\(/.test(src)) bad.push(`${r}: new Sortable ohne boardSortableOpts`);
    for (const k of ['chosenClass', 'ghostClass', 'dragClass']) {
      if (new RegExp(`\\b${k}\\s*:`).test(src)) bad.push(`${r}: eigene ${k}`);
    }
    if (/classList\.(add|toggle)\(['"][\w-]*dnd-active/.test(src)) bad.push(`${r}: eigene <body>-Drag-Klasse`);
  }
  assert.deepEqual(bad, [], `Board-Drag nicht ueber den Kern:\n  ${bad.join('\n  ')}`);
});

test('Board-Drag-Optik nur in board-dnd.css, keine fremde *-dnd-active-Klasse', () => {
  const bad = [];
  for (const f of walk(CSS_DIR, '.css')) {
    const r = rel(f);
    if (r === BOARD_CSS) continue;
    const src = stripComments(readFileSync(f, 'utf8'));
    if (/\.board-dnd-(ghost|chosen|dragging|zone)\b/.test(src)) bad.push(`${r}: Regel auf .board-dnd-*`);
    for (const m of src.matchAll(/\.([\w-]*dnd-active)\b/g)) {
      if (m[1] !== 'board-dnd-active') bad.push(`${r}: .${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `Board-Drag-Optik ausserhalb von ${BOARD_CSS}:\n  ${bad.join('\n  ')}`);
});

test('jede Board-Zelle traegt board-dnd-zone', () => {
  const html = walk(PARTIALS_DIR, '.html').map(f => [rel(f), readFileSync(f, 'utf8')]);
  const bad = [];
  for (const { attr, cls } of ZONES) {
    const tags = html.flatMap(([r, src]) => [...src.matchAll(new RegExp(`<[a-z]+[^>]*\\b:?${attr}\\b[^>]*>`, 'g'))]
      .map(m => [r, m[0]]));
    assert.ok(tags.length > 0, `kein Markup mit ${attr} gefunden`);
    for (const [r, tag] of tags) {
      const classAttr = tag.match(/\sclass="([^"]*)"/)?.[1] || '';
      if (!classAttr.split(/\s+/).includes(cls)) continue;
      if (!classAttr.split(/\s+/).includes('board-dnd-zone')) bad.push(`${r}: ${cls} ohne board-dnd-zone`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

// Native Drag-Quellen in der App. Datei-Drop (`drop`/`dragover` auf einer
// Ablageflaeche) ist keine Drag-QUELLE und darum hier nicht erfasst.
test('kein natives HTML5-Drag an Elementen', () => {
  const files = [
    ...walk(JS_DIR, '.js'),
    ...walk(PARTIALS_DIR, '.html'),
    join(REPO_ROOT, 'public', 'index.html'),
  ];
  const bad = [];
  for (const f of files) {
    const r = rel(f);
    const src = r.endsWith('.js') ? stripComments(readFileSync(f, 'utf8')) : readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    if (/\s:?draggable=["']?(true|\{)/.test(src)) bad.push(`${r}: draggable-Attribut`);
    if (/\.draggable\s*=\s*true/.test(src)) bad.push(`${r}: el.draggable = true`);
    if (/@dragstart\b|x-on:dragstart\b|['"]dragstart['"]/.test(src)) bad.push(`${r}: dragstart-Listener`);
  }
  assert.deepEqual(bad, [], `Natives Drag statt SortableJS-Kern (sortable-dnd.js):\n  ${bad.join('\n  ')}`);
});
