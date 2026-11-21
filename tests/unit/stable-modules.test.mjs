// Stabilisierte Module: Definition (scripts/stable-modules.js), npm-Skripte,
// Regel-Doku (docs/stabilisiert.md) und Modul-Doku muessen zusammenpassen.
// Regel: docs/stabilisiert.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ROOT, MODULES, listModuleFiles, moduleOf } = require('../../scripts/stable-modules.js');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const rule = fs.readFileSync(path.join(ROOT, 'docs/stabilisiert.md'), 'utf8');

for (const name of Object.keys(MODULES)) {
  const mod = MODULES[name];

  test(`${name}: npm-Skript laeuft ueber den gemeinsamen Runner`, () => {
    assert.equal(pkg.scripts[`test:${name}`], `node scripts/test-stable.js ${name}`);
  });

  test(`${name}: steht in der Tabelle der Regel-Doku`, () => {
    assert.match(rule, new RegExp(`npm run test:${name}`));
  });

  test(`${name}: Modul-Doku verweist auf die gemeinsame Regel`, () => {
    for (const doc of mod.docs) assert.ok(fs.existsSync(path.join(ROOT, doc)), doc);
    const linked = [...mod.docs, 'public/js/editor/CLAUDE.md']
      .filter((f) => fs.existsSync(path.join(ROOT, f)))
      .some((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('stabilisiert.md'));
    assert.ok(linked, `keine Doku von ${name} verlinkt docs/stabilisiert.md`);
  });

  test(`${name}: Umfang hat Code, Tests jeder Schicht, nur existierende Dateien`, () => {
    const { code, tests } = listModuleFiles(name);
    assert.ok(code.length > 0, 'kein Code im Umfang');
    assert.ok(tests.some((f) => f.startsWith('tests/unit/')), 'keine Unit-Tests');
    assert.ok(tests.some((f) => /^tests\/e2e(-app)?\//.test(f)), 'keine E2E-Tests');
    for (const f of [...code, ...tests]) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
    for (const f of mod.codeExplicit || []) assert.ok(code.includes(f), `explizite Datei fehlt: ${f}`);
    for (const f of mod.testExplicit || []) assert.ok(tests.includes(f), `expliziter Test fehlt: ${f}`);
  });
}

test('Focus-Umfang zieht die importierten shared-Module mit', () => {
  const { code } = listModuleFiles('focus');
  assert.ok(code.includes('public/js/editor/shared/edit-history.js'));
  assert.ok(code.includes('public/js/editor/shared/save-pipeline.js'));
  assert.deepEqual(moduleOf('public/js/editor/focus/typewriter.js'), ['focus']);
});

test('Kerndateien liegen im richtigen Modul', () => {
  assert.ok(moduleOf('routes/jobs/komplett/job-komplett.js').includes('komplett'));
  assert.ok(moduleOf('public/js/prompts/komplett/extraktion.js').includes('komplett'));
  assert.ok(moduleOf('routes/jobs/lektorat-filter.js').includes('lektorat'));
  assert.deepEqual(moduleOf('public/js/cards/plot-card.js'), []);
});

test('Offline-Umfang: SW-Dateien ja, generiertes Manifest nein', () => {
  const { code } = listModuleFiles('offline');
  for (const f of ['public/sw.js', 'public/sw-net.js', 'public/js/app/app-outbox.js', 'public/js/app/boot/sw-register.js']) {
    assert.ok(code.includes(f), f);
  }
  assert.ok(!code.includes('public/sw-manifest.js'), 'sw-manifest.js ist generiert — sonst wechselt der Stempel mit jedem Asset');
  assert.deepEqual(moduleOf('public/js/app/boot/internal-links.js'), []);
});
