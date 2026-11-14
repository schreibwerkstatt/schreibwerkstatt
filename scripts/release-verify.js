#!/usr/bin/env node
// `npm run release:verify -- <commit>`: testet einen Commit als Schnappschuss
// neben dem Arbeitsbaum, damit /release den Tree nicht fuer die Dauer von
// `test:ci` einfriert (.claude/commands/release.md).
//
// Ablauf:
//   1. `git archive <commit>` in ein frisches Verzeichnis unter os.tmpdir()
//      entpacken — kein Worktree, kein Branch (main-only-guard). Gitignorte
//      Dateien (.env, *.icc, DBs) fehlen dort wie im CI-Checkout.
//   2. node_modules als Symlink auf den Arbeitsbaum (Lockfile muss passen —
//      geprueft, sonst Abbruch).
//   3. `test:ci` mit TEST_CI_SHARDS=6 und eigenen Ports (E2E_PORT,
//      BOOT_SMOKE_PORT, TEST_CI_SHARD_BASE), damit ein gleichzeitiger Lauf
//      im Arbeitsbaum weder Port noch Server teilt.
//   4. Exit-Code von test:ci durchreichen. Gruen ⇒ Verzeichnis weg; rot ⇒
//      bleibt fuer die Diagnose liegen (Pfad steht am Ende der Ausgabe).
//
// Der Arbeitsbaum darf waehrenddessen beliebig weiterbearbeitet werden: der
// Lauf liest ausschliesslich den Schnappschuss.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const keep = args.includes('--keep');
const ref = args.find((a) => !a.startsWith('--')) || 'HEAD';

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

let sha;
try {
  sha = git('rev-parse', '--verify', `${ref}^{commit}`);
} catch {
  console.error(`release-verify: «${ref}» ist kein Commit.`);
  process.exit(2);
}

// node_modules wird geteilt, darum muss der Schnappschuss dasselbe Lockfile haben.
const lockAtSha = git('show', `${sha}:package-lock.json`);
const lockLocal = fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8').trim();
if (lockAtSha !== lockLocal) {
  console.error('release-verify: package-lock.json im Commit weicht vom Arbeitsbaum ab — '
    + 'node_modules passt nicht zum Schnappschuss. Erst `npm install` im Arbeitsbaum, dann erneut.');
  process.exit(2);
}

const dir = path.join(os.tmpdir(), `schreibwerkstatt-release-${sha.slice(0, 10)}`);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
execFileSync('sh', ['-c', `git archive --format=tar ${sha} | tar -x -C "${dir}"`], { cwd: ROOT, stdio: 'inherit' });
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');

console.log(`release-verify: ${sha.slice(0, 10)} in ${dir}`);

const env = {
  ...process.env,
  // 6 statt der 3 aus CI: die App-Specs laufen je Shard mit `workers: 1` und sind
  // der Engpass (3 Shards ≈ 11 min, 6 ≈ halb so lang); ~1,3 GB je Shard.
  TEST_CI_SHARDS: process.env.TEST_CI_SHARDS || '6',
  // Ports getrennt vom Arbeitsbaum: App-Shards 8828–8842 (8766 + 2·Shard), Harness 8865, Boot 33738.
  TEST_CI_SHARD_BASE: process.env.TEST_CI_SHARD_BASE || '30',
  E2E_PORT: process.env.E2E_PORT || '8865',
  BOOT_SMOKE_PORT: process.env.BOOT_SMOKE_PORT || '33738',
};

const child = spawn('node', ['scripts/test-ci.js'], { cwd: dir, env, stdio: 'inherit' });
child.on('close', (code) => {
  if (code === 0) {
    if (!keep) fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\nrelease-verify: GRUEN — ${sha}`);
  } else {
    console.log(`\nrelease-verify: ROT (exit ${code}) — ${sha}\nSchnappschuss zur Diagnose: ${dir}`);
  }
  process.exit(code ?? 1);
});
