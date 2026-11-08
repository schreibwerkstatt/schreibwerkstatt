// Gate ueber die Gates (DESIGN.md „Ein Muster, ein Ort"): jedes geteilte Muster
// hat einen `*-single-place`-Test, und der ist auffindbar. Ein Gate, das in
// keiner Kontextdatei steht, kennt beim naechsten Umbau niemand — er schlaegt
// an, ohne dass klar ist, welche Regel dahinter steht; ein Verweis auf einen
// geloeschten Test laesst eine Regel gegated aussehen, die es nicht mehr ist.
//
// Geprueft wird:
//   1. Jeder tests/unit/*-single-place.test.* ist in mindestens einer
//      Kontextdatei verlinkt (eine CLAUDE.md, DESIGN.md oder docs/**/*.md).
//   2. Jeder dort verlinkte *-single-place-Test existiert.
//   3. Jeder Test traegt im Kopf, was er prueft (Kommentar „Geprueft wird" bzw.
//      ein einleitender Kommentarblock) — sonst ist die Rot-Meldung ohne Regel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const UNIT_DIR = join(REPO_ROOT, 'tests', 'unit');
const SKIP_DIRS = new Set(['node_modules', '.git', 'tests', 'test-results', 'playwright-report']);

function walkMd(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkMd(full, out);
    else if (entry === 'CLAUDE.md' || entry === 'DESIGN.md' || (entry.endsWith('.md') && relative(REPO_ROOT, full).startsWith('docs/'))) out.push(full);
  }
  return out;
}

const gates = readdirSync(UNIT_DIR).filter(f => /-single-place\.test\.m?js$/.test(f));
const docs = walkMd(REPO_ROOT).map(f => [relative(REPO_ROOT, f), readFileSync(f, 'utf8')]);

test('es gibt single-place-Gates', () => {
  assert.ok(gates.length > 10, `nur ${gates.length} *-single-place-Tests gefunden — Pfad/Muster pruefen`);
});

test('jeder single-place-Gate ist in einer Kontextdatei verlinkt', () => {
  const missing = gates.filter(g => !docs.some(([, src]) => src.includes(g)));
  assert.deepEqual(missing, [],
    'Gate ohne Doku-Verweis — Zeile in der Tabelle „Mechanisch durchgesetzt" (CLAUDE.md) bzw. Abschnitt in DESIGN.md ergaenzen:\n  '
    + missing.join('\n  '));
});

test('jeder verlinkte single-place-Gate existiert', () => {
  const dead = [];
  for (const [r, src] of docs) {
    for (const m of src.matchAll(/([\w-]+-single-place\.test\.m?js)/g)) {
      if (!existsSync(join(UNIT_DIR, m[1]))) dead.push(`${r}: ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(dead)], [], `Verweis auf fehlenden Gate:\n  ${[...new Set(dead)].join('\n  ')}`);
});

test('jeder single-place-Gate erklaert im Kopf seine Regel', () => {
  const bare = gates.filter((g) => {
    const head = readFileSync(join(UNIT_DIR, g), 'utf8').split('\n').slice(0, 5).join('\n');
    return !/^\s*(\/\/|\/\*)/m.test(head);
  });
  assert.deepEqual(bare, [], `Gate ohne einleitenden Kommentar:\n  ${bare.join('\n  ')}`);
});
