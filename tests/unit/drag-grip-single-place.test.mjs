// Gate fuer den Drag-Griff (DESIGN.md „Drag-Griff", components/drag-grip.css):
// jeder SortableJS-Griff sieht gleich aus und sitzt gleich. Die Optik hat genau
// einen Ort — `.drag-grip` —, die Feature-Klasse daneben ist nur der `handle`-
// Anker fuer SortableJS.
//
// Geprueft wird:
//   1. Jede `handle: '.x'`-Klasse aus public/js steht im Markup nur an
//      Elementen mit `drag-grip`, `grip-vertical`-Icon und `aria-label` (nie
//      `aria-hidden`, kein Textzeichen wie `⋮⋮`).
//   2. Feature-CSS stylt eine Handle-Klasse hoechstens mit `font-size` (die
//      Zeilenhoehe, falls der Text daneben eine andere Groesse hat).
//   3. Ausserhalb von drag-grip.css gibt es keine Regel auf `.drag-grip`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const JS_DIR = join(REPO_ROOT, 'public', 'js');
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const INDEX_HTML = join(REPO_ROOT, 'public', 'index.html');
const CSS_DIR = join(REPO_ROOT, 'public', 'css');
const GRIP_CSS = 'public/css/components/drag-grip.css';

const ALLOWED_PROPS = new Set(['font-size']);

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const rel = (p) => relative(REPO_ROOT, p);

function handleClasses() {
  const out = new Map(); // class → [fundstelle]
  for (const file of walk(JS_DIR, '.js')) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bhandle:\s*['"]\.([\w-]+)['"]/g)) {
      if (!out.has(m[1])) out.set(m[1], []);
      out.get(m[1]).push(`${rel(file)}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  return out;
}

// Element-Oeffnungstag mit der Klasse + Inhalt bis zum passenden Schliesstag
// desselben Tag-Namens (Griffe sind flache <span>s, keine Verschachtelung).
function gripElements(cls) {
  const out = [];
  const re = new RegExp(`<(\\w+)\\b[^>]*\\bclass="([^"]*)"[^>]*>`, 'g');
  for (const file of [...walk(PARTIALS_DIR, '.html'), INDEX_HTML]) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const classes = m[2].split(/\s+/);
      if (!classes.includes(cls)) continue;
      const close = src.indexOf(`</${m[1]}>`, m.index);
      out.push({
        where: `${rel(file)}:${src.slice(0, m.index).split('\n').length}`,
        tag: m[0],
        classes,
        inner: src.slice(m.index + m[0].length, close),
      });
    }
  }
  return out;
}

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

const props = (body) => body.split(';')
  .map(d => d.slice(0, d.indexOf(':')).trim())
  .filter(Boolean);

test('jeder SortableJS-Griff ist ein .drag-grip mit Icon und Beschriftung', () => {
  const handles = handleClasses();
  assert.ok(handles.size > 0, 'keine `handle:`-Selektoren gefunden — Extraktion kaputt?');
  const problems = [];
  for (const [cls, src] of handles) {
    const els = gripElements(cls);
    if (!els.length) problems.push(`.${cls} (${src.join(', ')}): kein Element im Markup`);
    for (const el of els) {
      const miss = [];
      if (!el.classes.includes('drag-grip')) miss.push('Klasse drag-grip fehlt');
      if (!el.inner.includes('#grip-vertical')) miss.push('grip-vertical-Icon fehlt');
      if (/\baria-hidden="true"/.test(el.tag)) miss.push('aria-hidden statt Beschriftung');
      if (!/:?aria-label=/.test(el.tag)) miss.push('aria-label fehlt');
      if (/⋮/.test(el.inner)) miss.push('Textzeichen statt Icon');
      if (miss.length) problems.push(`.${cls} @ ${el.where}: ${miss.join(', ')}`);
    }
  }
  assert.equal(problems.length, 0,
    'Drag-Griff weicht vom Muster ab (DESIGN.md „Drag-Griff"):\n  ' + problems.join('\n  '));
});

test('Griff-Optik nur in drag-grip.css — Feature-CSS setzt hoechstens font-size', () => {
  const handles = [...handleClasses().keys()];
  const problems = [];
  for (const r of cssRules()) {
    for (const s of r.selectors) {
      if (r.file !== GRIP_CSS && /\.drag-grip(?![\w-])/.test(s)) {
        problems.push(`${r.file}: „${s}" — .drag-grip wird nur in ${GRIP_CSS} gestylt`);
      }
      for (const cls of handles) {
        if (!new RegExp(`\\.${cls}(?![\\w-])`).test(s)) continue;
        const bad = props(r.body).filter(p => !ALLOWED_PROPS.has(p));
        if (bad.length) problems.push(`${r.file}: „${s}" setzt ${bad.join(', ')}`);
      }
    }
  }
  assert.equal(problems.length, 0,
    'Griff-Styling ausserhalb der Komponente (DESIGN.md „Drag-Griff"):\n  ' + problems.join('\n  '));
});
