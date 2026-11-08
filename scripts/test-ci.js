#!/usr/bin/env node
// `npm run test:ci`: der Test-Job aus .github/workflows/deploy.yml lokal, in
// derselben Aufteilung — schneller als `npm test`, weil die Playwright-Suiten
// gleichzeitig statt nacheinander laufen und Firefox wegfaellt (CI: nur Chromium).
//
// Ablauf (billig vor teuer, Abbruch beim ersten roten Gate):
//   1. Import-Gate, Prompt-Config, Boot-Smoke
//   2. Unit, Integration
//   3. gleichzeitig: E2E-Harness (Port 8765), App-Specs Chromium in
//      TEST_CI_SHARDS Shards (Default 6, CI faehrt 3 —
//      lokal reicht der Speicher dafuer, ~1,3 GB je Shard; SMOKE_SHARD ab TEST_CI_SHARD_BASE
//      → Ports 8786/8788/…) und der Buendel-Smoke (naechster Shard, eigenes Bündel unter
//      tests/.tmp/bundle). CI faehrt den Buendel-Smoke danach; lokal reicht der
//      Speicher fuer alles auf einmal.
//
// Bewusst NICHT wie CI: kein `CI=true` — die Configs nehmen lokal mehr E2E-
// Worker und weniger Retries. Der Client-Kompatibilitaets-Check (Netz zu GitHub)
// bleibt bei `npm run check:clients`.

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PW = path.join(ROOT, 'node_modules', '.bin', 'playwright');
const SHARDS = Math.max(1, Number(process.env.TEST_CI_SHARDS) || 6);
// Eigener SMOKE_SHARD-Bereich (Default 10 → Ports ab 8786), damit ein parallel
// laufendes `npm run test:smoke` (8768–8773) weder Port noch DB teilt.
const BASE = Number(process.env.TEST_CI_SHARD_BASE) || 10;
const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000);

function run(cmd, args, { env = {}, buffer = false } = {}) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: buffer ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    if (buffer) {
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
    }
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function gate(name, cmd, args, env) {
  process.stdout.write(`\n===== ${name} (${secs()}s) =====\n`);
  const { code } = await run(cmd, args, { env });
  if (code !== 0) {
    process.stdout.write(`\nROT: ${name} (exit ${code}) nach ${secs()}s\n`);
    process.exit(code || 1);
  }
}

const summary = (out) => out.split('\n')
  .filter((l) => /^\s+\d+ (passed|failed|flaky|skipped|did not run)/.test(l))
  .map((l) => l.trim()).join(', ');

async function main() {
  await gate('Import-Gate', 'npm', ['run', '--silent', 'test:imports']);
  await gate('Prompt-Config', 'node', ['scripts/validate-prompt-config.js']);
  await gate('Boot-Smoke', 'node', ['scripts/boot-smoke.js']);
  await gate('Unit', 'npm', ['run', '--silent', 'test:unit']);
  await gate('Integration', 'npm', ['run', '--silent', 'test:integration']);

  const bundleShard = BASE + SHARDS + 1;
  const bundleDir = 'tests/.tmp/bundle';
  await gate('Bündel bauen', 'node', ['scripts/build-bundle.js', '--out', bundleDir]);

  process.stdout.write(`\n===== Playwright parallel: E2E + ${SHARDS} App-Shards + Bündel-Smoke (${secs()}s) =====\n`);
  const appEnv = { SMOKE_ENGINES: 'chromium' };
  // Die CI-Gewichte gelten nur fuer genau drei Shards (siehe deploy.yml).
  if (SHARDS === 3) appEnv.PWTEST_SHARD_WEIGHTS = process.env.PWTEST_SHARD_WEIGHTS || '29:39:32';

  const groups = [
    { name: 'E2E (Fixture-Harness)', args: ['test', '--reporter=list'] },
    ...Array.from({ length: SHARDS }, (_, k) => ({
      name: `App-Specs ${k + 1}/${SHARDS}`,
      args: ['test', '--config=playwright.app.config.js', '--project=chromium', '--reporter=list',
        ...(SHARDS > 1 ? [`--shard=${k + 1}/${SHARDS}`] : [])],
      env: { ...appEnv, SMOKE_SHARD: String(BASE + k + 1) },
    })),
    {
      name: 'Bündel-Smoke',
      args: ['test', '--config=playwright.app.config.js', '--project=chromium', '--reporter=list',
        'tests/e2e-app/bundle.spec.js', 'tests/e2e-app/smoke.spec.js',
        'tests/e2e-app/sw-drafts-sync.spec.js', 'tests/e2e-app/sw-offline-book.spec.js',
        'tests/e2e-app/sw-offline-editors.spec.js'],
      env: { SMOKE_ENGINES: 'chromium', SMOKE_SHARD: String(bundleShard), BUNDLE_DIR: bundleDir },
    },
  ];

  const results = await Promise.all(groups.map(async (g) => {
    const r = await run(PW, g.args, { env: g.env, buffer: true });
    process.stdout.write(`\n===== ${g.name} (exit ${r.code}, ${secs()}s) =====\n${r.out}`);
    return { name: g.name, code: r.code, summary: summary(r.out) };
  }));

  process.stdout.write(`\n===== Zusammenfassung (${secs()}s) =====\n`);
  for (const r of results) process.stdout.write(`${r.code === 0 ? 'ok  ' : 'ROT '} ${r.name}: ${r.summary || '—'}\n`);
  process.exit(results.some((r) => r.code !== 0) ? 1 : 0);
}

main();
