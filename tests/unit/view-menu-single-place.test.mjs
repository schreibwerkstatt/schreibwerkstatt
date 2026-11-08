// Gate fuer das Ansichts-Menue der Filterleiste (DESIGN.md „Ansichts-Menue",
// public/partials/view-menu.html, public/js/view-menu.js,
// components/view-menu.css). Schalter des Arbeitsmodus (Archiv einblenden,
// Erledigtes ausblenden, Dichte) stehen gesammelt hinter dem Knopf «Ansicht»
// mit der Zahl der Abweichungen — nicht als einzelne Haken in der Leiste und
// nicht in einem karteneigenen Nachbau des Menues.
//
// Geprueft wird:
//   1. Keine `.filter-bar` (samt per @include eingesetzter Fragmente) traegt
//      eine Checkbox, einen `menuitemcheckbox`-Schalter oder ein eigenes
//      `menu()` — ausser ueber `<!-- @include view-menu -->`.
//   2. `@include view-menu` steht nur innerhalb einer `.filter-bar`.
//   3. `.view-menu*`-Markup nur in view-menu.html, `.view-menu*`-CSS nur in
//      view-menu.css.
//   4. viewMenuChangeCount zaehlt Abweichungen von der Grundansicht.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { viewMenuChangeCount } from '../../public/js/view-menu.js';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const CSS_DIR = join(REPO_ROOT, 'public', 'css');
const INDEX_HTML = join(REPO_ROOT, 'public', 'index.html');
const VIEW_MENU_HTML = 'public/partials/view-menu.html';
const VIEW_MENU_CSS = 'public/css/components/view-menu.css';


function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}
const rel = (p) => relative(REPO_ROOT, p);
const stripComments = (html) => html.replace(/<!--(?!\s*@include)[\s\S]*?-->/g, '');
const INCLUDE_RE = /<!--\s*@include\s+([\w-]+)\s*-->/g;

// Fragment-Includes textuell aufloesen; `view-menu` bleibt als Marker stehen.
// Liefert zusaetzlich, aus welchen Dateien der Text stammt.
function resolve(html, seen = new Set()) {
  const files = new Set();
  const text = stripComments(html).replace(INCLUDE_RE, (m, name) => {
    if (name === 'view-menu' || seen.has(name)) return m;
    const p = join(PARTIALS_DIR, `${name}.html`);
    if (!existsSync(p)) return '';
    files.add(rel(p));
    const sub = resolve(readFileSync(p, 'utf8'), new Set([...seen, name]));
    sub.files.forEach(f => files.add(f));
    return sub.text;
  });
  return { text, files };
}

// Alle `.filter-bar`-Bloecke (balanciert ueber das oeffnende Tag-Element).
function filterBars(html) {
  const out = [];
  // Attributwerte duerfen `>` enthalten (`x-show="n > 0"`), darum attributweise.
  const re = /<(div|span|section)\b(?:[^>"]|"[^"]*")*?\sclass="(?:[^"]*\s)?filter-bar(?:\s[^"]*)?"(?:[^>"]|"[^"]*")*>/g;
  for (const m of html.matchAll(re)) {
    const tag = m[1];
    const openRe = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
    openRe.lastIndex = m.index + m[0].length;
    let depth = 1; let end = html.length;
    for (let t = openRe.exec(html); t; t = openRe.exec(html)) {
      depth += t[0].startsWith('</') ? -1 : 1;
      if (depth === 0) { end = t.index; break; }
    }
    out.push({ start: m.index, end, body: html.slice(m.index, end) });
  }
  return out;
}

const htmlFiles = () => [...walk(PARTIALS_DIR, '.html'), INDEX_HTML];

test('Filterleisten tragen keine eigenen Ansichts-Schalter — nur @include view-menu', () => {
  const offenders = [];
  for (const file of htmlFiles()) {
    const { text } = resolve(readFileSync(file, 'utf8'));
    for (const bar of filterBars(text)) {
      const body = bar.body.replace(INCLUDE_RE, '');
      const hits = [];
      if (/type="checkbox"/.test(body)) hits.push('Checkbox');
      if (/role="menuitemcheckbox"/.test(body)) hits.push('menuitemcheckbox');
      if (/x-data="menu\(\)"/.test(body)) hits.push('eigenes menu()');
      if (!hits.length) continue;
      offenders.push(`${rel(file)}: ${hits.join(', ')}`);
    }
  }
  assert.deepEqual(offenders, [],
    'Ansichts-Schalter in der Filterleiste gehoeren ins gemeinsame Ansichts-Menue: '
    + '`<!-- @include view-menu -->` + `viewMenuSpec()` in der Karte (public/js/view-menu.js). '
    + `Verstoesse:\n  ${offenders.join('\n  ')}`);
});

test('@include view-menu steht nur in einer Filterleiste', () => {
  const offenders = [];
  for (const file of htmlFiles()) {
    const raw = stripComments(readFileSync(file, 'utf8'));
    const bars = filterBars(raw);
    for (const m of raw.matchAll(/<!--\s*@include\s+view-menu\s*-->/g)) {
      if (!bars.some(b => m.index > b.start && m.index < b.end)) offenders.push(rel(file));
    }
  }
  assert.deepEqual(offenders, [], `@include view-menu ausserhalb einer .filter-bar: ${offenders.join(', ')}`);
});

test('.view-menu* nur im eigenen Partial und im eigenen CSS', () => {
  const offenders = [];
  for (const file of htmlFiles()) {
    if (rel(file) === VIEW_MENU_HTML) continue;
    const src = stripComments(readFileSync(file, 'utf8'));
    if (/class="[^"]*\bview-menu/.test(src)) offenders.push(`${rel(file)}: Markup`);
  }
  for (const file of walk(CSS_DIR, '.css')) {
    if (rel(file) === VIEW_MENU_CSS) continue;
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/\.view-menu[\w-]*/.test(css)) offenders.push(`${rel(file)}: CSS`);
  }
  assert.deepEqual(offenders, [], `.view-menu* ausserhalb von ${basename(VIEW_MENU_HTML)}/${basename(VIEW_MENU_CSS)}:\n  ${offenders.join('\n  ')}`);
});

test('viewMenuChangeCount: zaehlt Abweichungen von der Grundansicht', () => {
  const tg = (on, extra = {}) => ({ kind: 'toggle', key: String(Math.random()), on, toggle() {}, ...extra });
  assert.equal(viewMenuChangeCount([]), 0);
  assert.equal(viewMenuChangeCount(undefined), 0);
  assert.equal(viewMenuChangeCount([tg(false), tg(true), tg(true)]), 2);
  // Grundansicht «an»: erst das Abschalten ist eine Abweichung.
  assert.equal(viewMenuChangeCount([tg(true, { base: true })]), 0);
  assert.equal(viewMenuChangeCount([tg(false, { base: true })]), 1);
  // Einstellungen (counts: false) und Nicht-Schalter zaehlen nie.
  assert.equal(viewMenuChangeCount([tg(true, { counts: false }), { kind: 'header', key: 'h', label: 'x' }, { kind: 'sep', key: 's' }]), 0);
});
