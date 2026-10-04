#!/usr/bin/env node
// `npm run test:smoke`: die App-Suite (playwright.app.config.js) in parallelen
// Gruppen statt in einem Prozess. Die Config faehrt `workers: 1`, weil die Specs
// einer Gruppe einen Seed-Stand teilen — in einem Prozess liefen darum auch die
// Engines nacheinander, obwohl jede ihren eigenen Server samt DB hat.
//
// Jede Gruppe ist ein eigener Playwright-Prozess mit eigenem `SMOKE_SHARD`
// (→ eigene Ports, eigene Wegwerf-DB, eigener outputDir, siehe Config):
//   - Chromium in SMOKE_CHROMIUM_SHARDS Shards (Default 2, wie CI),
//   - Firefox als eine weitere Gruppe (traegt nur Smoke + Editor-Specs).
// Mit Spec-/Filter-Argumenten (`npm run test:smoke -- tests/e2e-app/x.spec.js`)
// laeuft Chromium ungeteilt — eine Handvoll Specs aufzuteilen spart nichts.
//
// Ausgabe pro Gruppe gepuffert und am Stueck ausgegeben, sobald die Gruppe
// fertig ist, damit die Reports nicht ineinanderlaufen.

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const extra = process.argv.slice(2);
const engines = (process.env.SMOKE_ENGINES || 'chromium,firefox').split(',');
const shards = extra.length ? 1 : Math.max(1, Number(process.env.SMOKE_CHROMIUM_SHARDS) || 2);

const groups = [];
if (engines.includes('chromium')) {
  for (let i = 1; i <= shards; i++) {
    groups.push({
      name: shards > 1 ? `chromium ${i}/${shards}` : 'chromium',
      shard: i,
      args: ['--project=chromium', ...(shards > 1 ? [`--shard=${i}/${shards}`] : [])],
      engine: 'chromium',
    });
  }
}
if (engines.includes('firefox')) {
  groups.push({ name: 'firefox', shard: shards + 1, args: ['--project=firefox'], engine: 'firefox' });
}

const bin = path.join(ROOT, 'node_modules', '.bin', 'playwright');
const t0 = Date.now();

function run(g) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(bin, [
      'test', '--config=playwright.app.config.js', '--reporter=list', '--pass-with-no-tests',
      ...g.args, ...extra,
    ], {
      cwd: ROOT,
      env: { ...process.env, SMOKE_SHARD: String(g.shard), SMOKE_ENGINES: g.engine },
    });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      const secs = Math.round((Date.now() - t0) / 1000);
      process.stdout.write(`\n===== ${g.name} (exit ${code}, ${secs}s) =====\n${out}`);
      const summary = out.split('\n').filter((l) => /^\s+\d+ (passed|failed|flaky|skipped|did not run)/.test(l))
        .map((l) => l.trim()).join(', ');
      resolve({ name: g.name, code, summary });
    });
  });
}

Promise.all(groups.map(run)).then((results) => {
  process.stdout.write(`\n===== Zusammenfassung (${Math.round((Date.now() - t0) / 1000)}s) =====\n`);
  for (const r of results) process.stdout.write(`${r.code === 0 ? 'ok  ' : 'ROT '} ${r.name}: ${r.summary || '—'}\n`);
  process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
});
