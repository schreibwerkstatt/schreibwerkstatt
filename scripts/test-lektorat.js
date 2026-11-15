#!/usr/bin/env node
'use strict';
// Sonderpruefung Lektorat (`npm run test:lektorat`). Faehrt jede Schicht, die
// Lektorat-Verhalten pinnt — Unit (Prompt-Vertrag, Filter, Merge, Anker,
// Chunks), Integration (Cache-Signatur, Fortschritt, Heatmap), Harness-E2E und
// die App-Suite mit vollem CSS — und stempelt nach gruenem Lauf den
// Fingerabdruck des Lektorat-Stands (scripts/lektorat-scope.js).
// Regel: docs/lektorat.md «Stabilisiert».
//
// Bricht bei der ersten roten Stufe ab. Hat sich der Lektorat-Stand waehrend
// des Laufs geaendert (parallele Sitzung, Auto-Commit), wird nicht gestempelt.

const { spawnSync } = require('node:child_process');
const net = require('node:net');
const { ROOT, listLektoratFiles, lektoratFingerprint, writeStamp } = require('./lektorat-scope');

const files = listLektoratFiles();
const pick = (re) => files.filter((f) => re.test(f));

// Tests ohne «lektorat» im Namen, die Lektorat-Invarianten gaten.
const EXTRA_INTEGRATION = ['tests/integration/cache-extras.test.js', 'tests/integration/heatmap-loaders.test.js'];
const EXTRA_APP = ['tests/e2e-app/fehler-heatmap.spec.js'];

const unit = pick(/^tests\/unit\/.*\.test\.m?js$/);
const integration = [...pick(/^tests\/integration\/.*\.test\.js$/), ...EXTRA_INTEGRATION];
const harness = pick(/^tests\/e2e\/.*\.spec\.js$/);
const app = [...pick(/^tests\/e2e-app\/.*\.spec\.js$/), ...EXTRA_APP];

// Freie Ports statt der Standard-Ports: parallele Sitzungen und Rest-Server
// belegen 8765/8766 oft, und die App-Config bricht bei belegtem Port bewusst
// ab. E2E_PORT (Harness) und SMOKE_SHARD (App-Suite: eigene Ports + eigene DB)
// sind die vorgesehenen Schalter der beiden Playwright-Configs.
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer().once('error', () => resolve(false))
      .once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port);
  });
}
async function pickPorts() {
  let e2ePort = null;
  for (let p = 8790; p < 8800 && !e2ePort; p++) if (await portFree(p)) e2ePort = p;
  let shard = null;
  for (let s = 5; s <= 12 && !shard; s++) {
    if (await portFree(8766 + s * 2) && await portFree(8767 + s * 2)) shard = s;
  }
  if (!e2ePort || !shard) throw new Error('keine freien Test-Ports gefunden (8790–8799 bzw. SMOKE_SHARD 5–12)');
  return { e2ePort, shard };
}

const STAGES = ({ e2ePort, shard }) => [
  { name: 'Unit', cmd: 'node', args: ['--test', '--test-concurrency=4', ...unit], env: { DB_FSYNC: 'off' } },
  { name: 'Integration', cmd: 'node', args: ['--test', '--test-concurrency=4', ...integration], env: { DB_FSYNC: 'off' } },
  { name: 'E2E-Harness', cmd: 'npx', args: ['playwright', 'test', '--project=chromium', ...harness], env: { E2E_PORT: String(e2ePort) } },
  { name: 'E2E-App (volles CSS)', cmd: 'npx', args: ['playwright', 'test', '--config=playwright.app.config.js', '--project=chromium', ...app], env: { SMOKE_SHARD: String(shard) } },
];

async function main() {
  const before = lektoratFingerprint();
  const t0 = Date.now();
  const ports = await pickPorts();
  console.log(`[test:lektorat] Ports: E2E_PORT=${ports.e2ePort}, SMOKE_SHARD=${ports.shard}`);

  for (const st of STAGES(ports)) {
    const n = st.args.filter((a) => a.startsWith('tests/')).length;
    console.log(`\n[test:lektorat] ${st.name} — ${n} Datei(en)`);
    const res = spawnSync(st.cmd, st.args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...(st.env || {}) } });
    if (res.status !== 0) {
      console.error(`\n[test:lektorat] ROT in Stufe «${st.name}». Ursache klaeren, nicht den Test anpassen (docs/lektorat.md «Stabilisiert»).`);
      process.exit(res.status || 1);
    }
  }

  const after = lektoratFingerprint();
  const secs = Math.round((Date.now() - t0) / 1000);
  if (after !== before) {
    console.error(`\n[test:lektorat] gruen nach ${secs} s, aber Lektorat-Dateien haben sich waehrend des Laufs geaendert — kein Stempel. Erneut laufen lassen.`);
    process.exit(1);
  }
  writeStamp(after);
  console.log(`\n[test:lektorat] gruen nach ${secs} s — Stand gestempelt.`);
}

main().catch((e) => { console.error('[test:lektorat] ' + (e && e.message)); process.exit(1); });
