// Gate fuer Aktionsmenues (DESIGN.md „Context-Menu", public/CLAUDE.md „Aktionsmenü"):
// jedes `.context-menu` hat genau zwei moegliche Mechaniken, und jedes Element,
// das per Rechtsklick ein Menue oeffnet, tut das auch per Long-Press.
//   - am Knopf verankert, in einem nicht klippenden Kopfbereich: `menu()`
//     (menu.js, `x-bind="trigger"` / `x-bind="panel"`)
//   - teleportiert, eine Instanz je Karte, geoeffnet per ⋯-Knopf, Rechtsklick
//     und Long-Press: `actionMenuState()`/`actionMenuMethods` (action-menu.js,
//     `x-bind="actionMenuPanel()"`, Knopf mit `isActionMenuOpen(…)`)
//
// Geprueft wird:
//   1. Jedes `.context-menu`-Element bindet eine der beiden Mechaniken.
//   2. Jeder ⋯-Knopf (`more-horizontal`) haengt an einer der beiden.
//   3. Jedes `@contextmenu` steht neben `x-long-press` (Touch hat keinen
//      Rechtsklick) und hat damit denselben Weg ins Menue.
//   4. Kein Modul ausser action-menu.js/menu.js baut die Schliess-Mechanik
//      eines Menues nach (eigener mousedown-Outside-Listener auf `.context-menu`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const INDEX_HTML = join(REPO_ROOT, 'public', 'index.html');
const JS_DIR = join(REPO_ROOT, 'public', 'js');
const rel = (p) => relative(REPO_ROOT, p);

// Content-Popover in `.context-menu`-Huelle (reicher Inhalt statt Aktionen,
// eigene Mechanik) — DESIGN.md „Content-Popover-Ausnahme".
const CONTENT_POPOVERS = new Map([
  ['plot-occ-popover', 'Plot-Fundstellen-Popover (Seitenname + Score + Snippet, plot/ai.js)'],
]);
// ⋯-Knoepfe, die kein Aktionsmenue oeffnen.
const NOT_A_MENU_TRIGGER = new Map([
  ['showKomplettStatus', 'Komplettanalyse-Statuspanel (Fortschritt + Aktionen, oeffnet auch per Hover)'],
]);
// Rechtsklick ohne Aktionsmenue: der Editor zeigt dort Rechtschreib-/Synonym-
// Vorschlaege zum markierten Text, kein Element-Menue.
const NATIVE_CONTEXTMENU = ['_onEditContextMenu('];

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const htmlFiles = () => [...walk(PARTIALS_DIR, '.html'), INDEX_HTML];
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const openTags = (src) => src.matchAll(/<(\w+)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g);

test('jedes .context-menu bindet menu() oder action-menu', () => {
  const bad = [];
  for (const file of htmlFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of openTags(src)) {
      const cls = (m[2].match(/\bclass="([^"]*)"/) || [])[1];
      if (!cls) continue;
      const classes = cls.split(/\s+/);
      if (!classes.includes('context-menu')) continue;
      if (classes.some((c) => CONTENT_POPOVERS.has(c))) continue;
      if (/x-bind="panel"/.test(m[2]) || /x-bind="actionMenuPanel\(\)"/.test(m[2])) continue;
      bad.push(`${rel(file)}:${lineOf(src, m.index)}  <${m[1]} class="${cls}">`);
    }
  }
  assert.deepEqual(bad, [],
    'Handverdrahtetes Menue — verankert im Kopfbereich: `x-data="menu()"` + `x-bind="panel"`; ' +
    'teleportiert/Rechtsklick: `x-ref="actionMenu" x-bind="actionMenuPanel()"` (action-menu.js):\n' + bad.join('\n'));
});

test('jeder ⋯-Knopf haengt an menu() oder action-menu', () => {
  const bad = [];
  for (const file of htmlFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<button\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/button>/g)) {
      if (!m[2].includes('#more-horizontal')) continue;
      const attrs = m[1];
      if (/x-bind="trigger"/.test(attrs) || /isActionMenuOpen\(/.test(attrs)) continue;
      if ([...NOT_A_MENU_TRIGGER.keys()].some((k) => attrs.includes(k))) continue;
      bad.push(`${rel(file)}:${lineOf(src, m.index)}`);
    }
  }
  assert.deepEqual(bad, [],
    '⋯-Knopf ohne Menue-Baustein — `x-bind="trigger"` (menu()) oder ' +
    '`:aria-expanded="isActionMenuOpen(key)"` + Oeffner aus action-menu.js:\n' + bad.join('\n'));
});

test('jedes @contextmenu hat x-long-press daneben', () => {
  const bad = [];
  for (const file of htmlFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of openTags(src)) {
      const handler = (m[2].match(/@contextmenu(?:\.\w+)*="([^"]*)"/) || [])[1];
      if (handler == null) continue;
      if (NATIVE_CONTEXTMENU.some((n) => handler.includes(n))) continue;
      if (/\sx-long-press(?=[\s>=]|$)/.test(m[2])) continue;
      bad.push(`${rel(file)}:${lineOf(src, m.index)}  @contextmenu="${handler.slice(0, 60)}"`);
    }
  }
  assert.deepEqual(bad, [],
    'Rechtsklick-Menue ohne Long-Press — Touch-Geraete erreichen es sonst nicht. ' +
    '`x-long-press` ans selbe Element:\n' + bad.join('\n'));
});

test('keine eigene Schliess-Mechanik fuer .context-menu neben action-menu.js/menu.js', () => {
  const bad = [];
  for (const file of walk(JS_DIR, '.js')) {
    const r = rel(file);
    if (r === 'public/js/action-menu.js' || r === 'public/js/menu.js') continue;
    const src = readFileSync(file, 'utf8');
    // Outside-Click per Hand: mousedown-Listener, der ein `.context-menu`/`*-context-menu` sucht.
    if (/addEventListener\(\s*['"]mousedown['"]/.test(src) && /querySelector\([^)]*context-menu/.test(src)) {
      bad.push(r);
    }
  }
  assert.deepEqual(bad, [],
    'Eigener Outside-Click fuer ein Menue — Mechanik gehoert action-menu.js:\n' + bad.join('\n'));
});
