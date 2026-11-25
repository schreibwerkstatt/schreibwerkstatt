// Gate fuer den Job-Fortschritt (DESIGN.md „Job-Fortschritt", public/js/job-progress.js):
// Balken + Statuszeile + «Abbrechen» eines laufenden Jobs entstehen
// ausschliesslich in der Direktive `x-job-progress`; die Optik steht
// ausschliesslich in components/card-form/card-blocks.css.
//
// Geprueft wird:
//   1. Kein Partial (und nicht index.html) baut `.progress-bar-wrap`,
//      `.job-progress` oder `.job-progress-row` von Hand — ausser den
//      Fortschritts-Balken, die keinen Job zeigen (Ziele, Meilensteine,
//      Onboarding, Lineal im Seitenkopf; Liste NON_JOB_BARS).
//   2. Jedes `x-job-progress`-Element ist leer — den Inhalt schreibt die Direktive.
//   3. Ausserhalb von card-blocks.css stylt keine Regel `.job-progress*`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const rel = (p) => relative(REPO_ROOT, p);
const OWNER_CSS = 'public/css/components/card-form/card-blocks.css';

// Balken ohne Job: Fortschritt eines Ziels oder einer Füllung, kein Lauf.
const NON_JOB_BARS = new Set([
  'public/partials/bookoverview-charts.html',   // Schreibziel-Projektion
  'public/partials/onboarding.html',            // Onboarding-Checkliste
  'public/partials/editor-page-head.html',      // Längen-Lineal der Kopffelder
  'public/partials/my-stats.html',              // nächster Meilenstein
  'public/partials/my-stats-insights.html',     // Tagesziel
  'public/partials/my-stats-book-goals.html',   // Buchziele
]);

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'vendor' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const markupFiles = [
  ...walk(join(REPO_ROOT, 'public', 'partials'), '.html'),
  join(REPO_ROOT, 'public', 'index.html'),
];

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

test('Job-Fortschritt nur ueber x-job-progress, kein handgebauter Balken', () => {
  const bad = [];
  for (const f of markupFiles) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/class\s*=\s*"([^"]*)"/g)) {
      const cls = m[1].split(/\s+/);
      const jobBlock = cls.includes('job-progress') || cls.includes('job-progress-row');
      const bar = cls.includes('progress-bar-wrap');
      if (jobBlock || (bar && !NON_JOB_BARS.has(rel(f)))) bad.push(`${rel(f)}:${lineOf(src, m.index)}`);
    }
  }
  assert.deepEqual(bad, [],
    `Job-Fortschritt von Hand gebaut — <div x-job-progress="{ active, progress, status, timer }"></div> verwenden:\n  ${bad.join('\n  ')}`);
});

test('x-job-progress-Elemente sind leer', () => {
  const bad = [];
  for (const f of markupFiles) {
    const src = readFileSync(f, 'utf8');
    // Attributwerte quote-bewusst überspringen: `cancel: () => …` trägt ein `>`.
    const attrs = `(?:[^>"']|"[^"]*"|'[^']*')*`;
    const re = new RegExp(`<(\\w+)\\b${attrs}\\bx-job-progress=${attrs}>([\\s\\S]*?)<\\/\\1>`, 'g');
    for (const m of src.matchAll(re)) {
      if (m[2].trim()) bad.push(`${rel(f)}:${lineOf(src, m.index)}`);
    }
  }
  assert.deepEqual(bad, [], `x-job-progress mit Inhalt — Element leer lassen:\n  ${bad.join('\n  ')}`);
});

test('.job-progress wird nur in card-blocks.css gestylt', () => {
  const bad = [];
  for (const f of walk(join(REPO_ROOT, 'public', 'css'), '.css')) {
    if (rel(f) === OWNER_CSS) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\.job-progress[\w-]*/g)) bad.push(`${rel(f)}:${lineOf(src, m.index)}`);
  }
  assert.deepEqual(bad, [], `eigenes Styling des Job-Fortschritts — gehoert nach ${OWNER_CSS}:\n  ${bad.join('\n  ')}`);
});
