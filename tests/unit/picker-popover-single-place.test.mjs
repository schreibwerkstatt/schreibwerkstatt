// Gate fuer das Picker-Popover (DESIGN.md „Picker-Popover",
// public/js/picker-popover.js, components/picker-popover.css): eine Auswahl an
// EINEM Element (verknuepfen, verschieben, zuordnen) geht am Knopf auf, nennt
// im Kopf das Element und teilt sich Positionierung und Schliessen mit allen
// anderen Pickern. Mechanik und Optik haben je genau einen Ort.
//
// Geprueft wird:
//   1. Jedes `.picker-popover` im Markup ist teleportiert, traegt eine
//      Konsumenten-Klasse, x-ref, role="dialog" + :aria-label, Outside-Click-
//      und Esc-Abbruch, `:style` in Objekt-Form aus `pickerPopoverPos` sowie
//      Kopf (Titel + Subjekt) und Aktionen.
//   2. `pickerPopoverPos` steht im Markup nur an `.picker-popover`-Elementen.
//   3. Jeder `_openPickerPopover(…, 'ref')` zeigt auf ein `.picker-popover`
//      mit diesem x-ref, und jedes `.picker-popover` wird so geoeffnet.
//   4. State und Methoden kommen nur aus picker-popover.js (kein Nachbau).
//   5. `.picker-popover*` wird nur in picker-popover.css gestylt; eine
//      Konsumenten-Klasse setzt hoechstens `--picker-popover-w`, und dann gibt
//      ihr Oeffnen dieselbe Breite als `w` mit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const JS_DIR = join(REPO_ROOT, 'public', 'js');
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const INDEX_HTML = join(REPO_ROOT, 'public', 'index.html');
const CSS_DIR = join(REPO_ROOT, 'public', 'css');
const PICKER_JS = 'public/js/picker-popover.js';
const PICKER_CSS = 'public/css/components/picker-popover.css';

const ALLOWED_CONSUMER_PROPS = new Set(['--picker-popover-w']);

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const rel = (p) => relative(REPO_ROOT, p);
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const htmlFiles = () => [...walk(PARTIALS_DIR, '.html'), INDEX_HTML];

// Oeffnungstag (mehrzeilig) eines Elements mit Klasse `picker-popover`; Inhalt
// bis zum `</template>` des Teleports (das Popover ist dessen einziges Kind).
function popovers() {
  const out = [];
  const re = /<(\w+)\b[^>]*?\bclass="([^"]*)"[^>]*>/g;
  for (const file of htmlFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const classes = m[2].split(/\s+/);
      if (!classes.includes('picker-popover')) continue;
      const before = src.slice(0, m.index);
      const tplOpen = before.lastIndexOf('<template');
      const tplTag = tplOpen >= 0 ? before.slice(tplOpen, before.indexOf('>', tplOpen) + 1) : '';
      const teleported = tplOpen >= 0
        && before.lastIndexOf('</template>') < tplOpen
        && /\bx-teleport=/.test(tplTag);
      const end = src.indexOf('</template>', m.index);
      out.push({
        where: `${rel(file)}:${lineOf(src, m.index)}`,
        tag: m[0],
        classes,
        ref: m[0].match(/\bx-ref="([^"]+)"/)?.[1] || null,
        teleported,
        inner: src.slice(m.index + m[0].length, end < 0 ? undefined : end),
      });
    }
  }
  return out;
}

function openCalls() {
  const out = [];
  for (const file of walk(JS_DIR, '.js')) {
    if (rel(file) === PICKER_JS) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\._openPickerPopover\(\s*[^,]+,\s*['"]([\w-]+)['"]([^;]*)/g)) {
      out.push({ where: `${rel(file)}:${lineOf(src, m.index)}`, ref: m[1], rest: m[2] });
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

const decls = (body) => body.split(';')
  .map(d => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()])
  .filter(([p]) => p);

test('jedes .picker-popover folgt dem Markup-Rahmen', () => {
  const pops = popovers();
  assert.ok(pops.length > 0, 'kein .picker-popover im Markup gefunden — Extraktion kaputt?');
  const problems = [];
  for (const p of pops) {
    const miss = [];
    if (!p.teleported) miss.push('nicht in <template x-teleport>');
    if (p.classes.filter(c => c && c !== 'picker-popover').length === 0) miss.push('Konsumenten-Klasse fehlt');
    if (!p.ref) miss.push('x-ref fehlt');
    if (!/\brole="dialog"/.test(p.tag)) miss.push('role="dialog" fehlt');
    if (!/:aria-label=/.test(p.tag)) miss.push(':aria-label fehlt');
    // Klick daneben schliesst picker-popover.js (mousedown), siehe DESIGN.md.
    if (/@click\.outside/.test(p.tag)) miss.push('@click.outside statt Mechanik aus picker-popover.js');
    if (!/@keydown\.escape[\w.]*=/.test(p.tag)) miss.push('Esc-Abbruch fehlt');
    if (!/:style="\{\s*top:\s*pickerPopoverPos\.top\b[^"]*left:\s*pickerPopoverPos\.left\b/.test(p.tag)) {
      miss.push(':style nicht in Objekt-Form aus pickerPopoverPos');
    }
    for (const part of ['__head', '__title', '__subject', '__actions']) {
      if (!new RegExp(`\\bpicker-popover${part}\\b`).test(p.inner)) miss.push(`picker-popover${part} fehlt`);
    }
    if (miss.length) problems.push(`${p.where}: ${miss.join(', ')}`);
  }
  assert.equal(problems.length, 0,
    'Picker-Popover weicht vom Rahmen ab (DESIGN.md „Picker-Popover"):\n  ' + problems.join('\n  '));
});

test('pickerPopoverPos steht nur an .picker-popover-Elementen', () => {
  const problems = [];
  for (const file of htmlFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<(\w+)\b[^>]*\bpickerPopoverPos\b[^>]*>/g)) {
      const cls = m[0].match(/\bclass="([^"]*)"/)?.[1].split(/\s+/) || [];
      if (!cls.includes('picker-popover')) problems.push(`${rel(file)}:${lineOf(src, m.index)}`);
    }
  }
  assert.equal(problems.length, 0,
    'pickerPopoverPos ausserhalb eines .picker-popover — eigenes Popover auf der geteilten Position:\n  '
    + problems.join('\n  '));
});

test('_openPickerPopover und .picker-popover-Refs passen paarweise zusammen', () => {
  const pops = popovers();
  const calls = openCalls();
  const refs = new Set(pops.map(p => p.ref).filter(Boolean));
  const opened = new Set(calls.map(c => c.ref));
  const problems = [];
  for (const c of calls) {
    if (!refs.has(c.ref)) problems.push(`${c.where}: '${c.ref}' ist kein x-ref an einem .picker-popover`);
  }
  for (const p of pops) {
    if (p.ref && !opened.has(p.ref)) problems.push(`${p.where}: '${p.ref}' wird nie per _openPickerPopover geoeffnet`);
  }
  assert.equal(problems.length, 0, problems.join('\n  '));
});

test('Picker-Mechanik nur aus picker-popover.js', () => {
  const problems = [];
  for (const file of walk(JS_DIR, '.js')) {
    if (rel(file) === PICKER_JS) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/^\s*(_openPickerPopover|_releasePickerPopover|_refinePickerPopover)\s*\(/gm)) {
      problems.push(`${rel(file)}:${lineOf(src, m.index)}: ${m[1]} neu definiert`);
    }
    for (const m of src.matchAll(/\bpickerPopoverPos\s*:/g)) {
      problems.push(`${rel(file)}:${lineOf(src, m.index)}: pickerPopoverPos neu angelegt — pickerPopoverState() spreaden`);
    }
  }
  assert.equal(problems.length, 0,
    'Nachbau der Picker-Mechanik (DESIGN.md „Picker-Popover"):\n  ' + problems.join('\n  '));
});

test('Picker-Optik nur in picker-popover.css — Konsumenten setzen hoechstens die Breite', () => {
  const pops = popovers();
  const calls = openCalls();
  const consumers = new Map(); // Klasse → x-ref
  for (const p of pops) {
    for (const c of p.classes) if (c && c !== 'picker-popover') consumers.set(c, p.ref);
  }
  const problems = [];
  for (const r of cssRules()) {
    for (const s of r.selectors) {
      if (r.file !== PICKER_CSS && /\.picker-popover(?![a-z0-9])/.test(s)) {
        problems.push(`${r.file}: „${s}" — .picker-popover* wird nur in ${PICKER_CSS} gestylt`);
      }
      for (const [cls, ref] of consumers) {
        if (!new RegExp(`\\.${cls}(?![\\w-])`).test(s)) continue;
        // Nur die Konsumenten-Klasse selbst, nicht ihre Kinder (Felder im Picker).
        if (!new RegExp(`\\.${cls}\\s*$`).test(s)) continue;
        const ds = decls(r.body);
        const bad = ds.map(([p]) => p).filter(p => !ALLOWED_CONSUMER_PROPS.has(p));
        if (bad.length) problems.push(`${r.file}: „${s}" setzt ${bad.join(', ')}`);
        const w = ds.find(([p]) => p === '--picker-popover-w')?.[1];
        if (w && !calls.some(c => c.ref === ref && /\bw\s*:/.test(c.rest))) {
          problems.push(`${r.file}: „${s}" setzt --picker-popover-w: ${w}, aber _openPickerPopover(…, '${ref}') gibt kein { w } mit`);
        }
      }
    }
  }
  assert.equal(problems.length, 0,
    'Picker-Styling ausserhalb der Komponente (DESIGN.md „Picker-Popover"):\n  ' + problems.join('\n  '));
});
