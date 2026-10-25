// Gate fuer den Section-Trenner im Formular (DESIGN.md „Section-Trenner
// innerhalb des Forms", public/CLAUDE.md): eine Gruppe von Formularzeilen
// bekommt ihren Titel ausschliesslich als `.card-form-section-divider`
// (Linie oben + Titelschrift); ein erklaerender Satz zur Gruppe statt eines
// Titels zusaetzlich `--note`.
//
// Geprueft wird:
//   1. Jeder Trenner traegt seinen Text als literalen i18n-Key; Titel (kurz,
//      ohne Satzzeichen am Ende) stehen ohne `--note`, Saetze mit `--note`.
//   2. Ausserhalb von form-elements.css setzt kein CSS Schrift-/Farb-Optik
//      auf den Trenner — Abweichungen tragen nur Abstand/Linie.
//   3. Keine zweite Klasse `card-form-(section|group)-…` fuer dieselbe Rolle.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const INDEX_HTML = join(REPO_ROOT, 'public', 'index.html');
const CSS_DIR = join(REPO_ROOT, 'public', 'css');
const OWNER_CSS = 'public/css/components/card-form/form-elements.css';
const DE = JSON.parse(readFileSync(join(REPO_ROOT, 'public', 'js', 'i18n', 'de.json'), 'utf8'));
const rel = (p) => relative(REPO_ROOT, p);

const BASE = 'card-form-section-divider';
const NOTE = `${BASE}--note`;
const LOOK_PROPS = /^(color|font-size|font-style|font-weight|font-family|text-transform|letter-spacing)$/;
// Ein Titel ist kurz und endet nicht wie ein Satz.
const TITLE_MAX = 40;
const isSentence = (s) => s.length > TITLE_MAX || /[.!?:]$/.test(s.trim());

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

test('Trenner: Titel ohne --note, erklaerender Satz mit --note', () => {
  const bad = [];
  const re = /<\w+\b[^>]*?\bclass="([^"]*)"[^>]*>/gs;
  for (const file of htmlFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const classes = m[1].split(/\s+/);
      if (!classes.includes(BASE)) continue;
      const at = `${rel(file)}:${lineOf(src, m.index)}`;
      const key = (m[0].match(/\$app\.t\('([^']+)'\)/) || [])[1];
      if (!key || !(key in DE)) { bad.push(`${at}  Text nicht als literaler i18n-Key auffindbar`); continue; }
      const sentence = isSentence(DE[key]);
      const hasNote = classes.includes(NOTE);
      if (sentence && !hasNote) bad.push(`${at}  „${DE[key]}" ist ein Satz — \`${NOTE}\` dazusetzen`);
      if (!sentence && hasNote) bad.push(`${at}  „${DE[key]}" ist ein Titel — \`${NOTE}\` entfernen`);
    }
  }
  assert.deepEqual(bad, [], 'Section-Trenner falsch eingesetzt:\n' + bad.join('\n'));
});

test('Optik des Trenners nur in form-elements.css', () => {
  const bad = [];
  for (const file of walk(CSS_DIR, '.css')) {
    if (rel(file) === OWNER_CSS) continue;
    const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim();
      const last = selector.split(',').map((s) => s.trim().split(/[\s>+~]+/).pop());
      if (!last.some((sel) => sel.includes(`.${BASE}`))) continue;
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
    `Die Schrift des Section-Trenners kommt aus ${OWNER_CSS} — Feature-CSS traegt nur ` +
    'Abstand/Linie:\n' + bad.join('\n'));
});

test('Kein zweiter Gruppen-Titel neben card-form-section-divider', () => {
  const bad = [];
  const allowed = new Set([BASE, NOTE]);
  const isRival = (c) => /^card-form-(section|group)(-|$)/.test(c) && !allowed.has(c);
  for (const file of htmlFiles()) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bclass="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/).filter(isRival)) bad.push(`${rel(file)}:${lineOf(src, m.index)}  ${c}`);
    }
  }
  for (const file of walk(CSS_DIR, '.css')) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\.(card-form-[\w-]+)/g)) {
      if (isRival(m[1])) bad.push(`${rel(file)}:${lineOf(src, m.index)}  .${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `Gruppen-Titel im Formular nur als \`${BASE}\`:\n` + bad.join('\n'));
});
