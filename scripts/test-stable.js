#!/usr/bin/env node
'use strict';
// Sonderpruefung eines stabilisierten Moduls:
//   node scripts/test-stable.js <lektorat|focus|komplett>   (npm run test:<modul>)
//   node scripts/test-stable.js --status                    (npm run stable:status)
// Faehrt jede Schicht, die das Modul pinnt — Unit, Integration, Harness-E2E
// (Chromium, dazu WebKit fuer `*.webkit.spec.js`) und die App-Suite mit vollem
// CSS — und stempelt nach gruenem Lauf den Fingerabdruck des Modul-Stands.
// Umfang: scripts/stable-modules.js. Regel: docs/stabilisiert.md.
//
// Bricht bei der ersten roten Stufe ab. Hat sich der Modul-Stand waehrend des
// Laufs geaendert (parallele Sitzung, Auto-Commit), wird nicht gestempelt.

const { spawnSync } = require('node:child_process');
const net = require('node:net');
const { ROOT, MODULES, listModuleFiles, fingerprint, readStamp, writeStamp } = require('./stable-modules');

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

function stages(name, tests, { e2ePort, shard }) {
  const pick = (re) => tests.filter((f) => re.test(f));
  const unit = pick(/^tests\/unit\//);
  const integration = pick(/^tests\/integration\//);
  const harness = pick(/^tests\/e2e\/.*(?<!\.webkit)\.spec\.js$/);
  const webkit = pick(/^tests\/e2e\/.*\.webkit\.spec\.js$/);
  const app = pick(/^tests\/e2e-app\//);
  // WebKit bricht mit gesetztem GIO_MODULE_DIR bei jeder Navigation ab.
  const noGio = { ...process.env };
  delete noGio.GIO_MODULE_DIR;
  return [
    { name: 'Unit', files: unit, cmd: 'node', args: ['--test', '--test-concurrency=4', ...unit], env: { ...process.env, DB_FSYNC: 'off' } },
    { name: 'Integration', files: integration, cmd: 'node', args: ['--test', '--test-concurrency=4', ...integration], env: { ...process.env, DB_FSYNC: 'off' } },
    { name: 'E2E-Harness (Chromium)', files: harness, cmd: 'npx', args: ['playwright', 'test', '--project=chromium', ...harness], env: { ...process.env, E2E_PORT: String(e2ePort) } },
    { name: 'E2E-Harness (WebKit)', files: webkit, cmd: 'npx', args: ['playwright', 'test', '--project=webkit', ...webkit], env: { ...noGio, E2E_PORT: String(e2ePort) } },
    { name: 'E2E-App (volles CSS)', files: app, cmd: 'npx', args: ['playwright', 'test', '--config=playwright.app.config.js', ...app],
      env: { ...process.env, SMOKE_SHARD: String(shard), SMOKE_ENGINES: MODULES[name].appEngines } },
  ].filter((st) => st.files.length > 0);
}

async function run(name) {
  const tag = `[test:${name}]`;
  const before = fingerprint(name);
  const { code, tests } = listModuleFiles(name);
  const t0 = Date.now();
  const ports = await pickPorts();
  console.log(`${tag} ${MODULES[name].title}: ${code.length} Code-Datei(en), ${tests.length} Test-Datei(en). Ports: E2E_PORT=${ports.e2ePort}, SMOKE_SHARD=${ports.shard}`);

  for (const st of stages(name, tests, ports)) {
    console.log(`\n${tag} ${st.name} — ${st.files.length} Datei(en)`);
    const res = spawnSync(st.cmd, st.args, { cwd: ROOT, stdio: 'inherit', env: st.env });
    if (res.status !== 0) {
      console.error(`\n${tag} ROT in Stufe «${st.name}». Ursache klaeren, nicht den Test anpassen (docs/stabilisiert.md).`);
      process.exit(res.status || 1);
    }
  }

  const after = fingerprint(name);
  const secs = Math.round((Date.now() - t0) / 1000);
  if (after !== before) {
    console.error(`\n${tag} gruen nach ${secs} s, aber Modul-Dateien haben sich waehrend des Laufs geaendert — kein Stempel. Erneut laufen lassen.`);
    process.exit(1);
  }
  writeStamp(name, after);
  console.log(`\n${tag} gruen nach ${secs} s — Stand gestempelt.`);
}

function status() {
  let dirty = 0;
  for (const name of Object.keys(MODULES)) {
    const stamp = readStamp(name);
    const fp = fingerprint(name);
    let line;
    if (!stamp) { line = 'nie gestempelt'; dirty++; }
    else if (stamp.fingerprint === fp) line = `unveraendert seit gruener Sonderpruefung (${stamp.at})`;
    else { line = `GEAENDERT seit letzter gruener Sonderpruefung (${stamp.at}) — npm run test:${name}`; dirty++; }
    console.log(`${MODULES[name].title.padEnd(16)} ${line}`);
  }
  process.exit(dirty ? 1 : 0);
}

const arg = process.argv[2];
if (arg === '--status') status();
else if (arg === '--list') {
  const name = process.argv[3];
  const { code, tests } = listModuleFiles(name);
  console.log(['# Code', ...code, '', '# Tests', ...tests].join('\n'));
} else if (MODULES[arg]) run(arg).catch((e) => { console.error(`[test:${arg}] ` + (e && e.message)); process.exit(1); });
else {
  console.error(`Aufruf: node scripts/test-stable.js <${Object.keys(MODULES).join('|')}> | --status | --list <modul>`);
  process.exit(2);
}
