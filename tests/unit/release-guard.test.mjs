// release-guard.js: zwischen Release-Commit und Tag darf keine Sitzung main
// pushen, den Release-Commit rebasen oder hinter ihn zurücksetzen. Geprüft an
// einem echten Wegwerf-Repo (bare origin + Klon), weil die Regel an git-Graph-
// Fragen hängt (origin/main..HEAD, Tag deckt Commit), nicht an Strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decide, pushesMain } = require('../../scripts/hooks/release-guard.js');

function sh(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
}

function commit(dir, file, msg) {
  fs.writeFileSync(path.join(dir, file), msg + '\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', msg);
  return sh(dir, 'rev-parse', 'HEAD');
}

/** origin/main = base; lokal: release-Commit + ein Fix darauf. */
function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-guard-'));
  const origin = path.join(tmp, 'origin.git');
  const repo = path.join(tmp, 'repo');
  sh(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(tmp, 'clone', '-q', origin, repo);
  sh(repo, 'checkout', '-q', '-b', 'main');
  const base = commit(repo, 'a.txt', 'base');
  sh(repo, 'push', '-q', 'origin', 'main');
  const release = commit(repo, 'VERSION', 'release: v1.0.1');
  const fix = commit(repo, 'b.txt', 'fix danach');
  const other = path.join(tmp, 'other');
  fs.mkdirSync(other);
  return { tmp, repo, base, release, fix, other };
}

test('offener Release: Push auf main, Rebase, Reset dahinter sind blockiert', () => {
  const r = setup();
  const d = (cmd) => decide(cmd, r.repo, r.repo);
  assert.ok(d('git push origin main'), 'push main');
  assert.ok(d('git push'), 'push ohne Argumente');
  assert.ok(d(`git push origin ${r.base}:refs/heads/main`), 'Fremd-Commit am Release vorbei');
  assert.ok(d(`git push origin ${r.release}:refs/heads/main`), 'Release-Commit vor dem Tag');
  assert.ok(d('git push --force origin main'), 'force push');
  assert.ok(d(`git rebase --onto origin/main ${r.base}`), 'rebase');
  assert.ok(d('git pull --rebase'), 'pull --rebase');
  assert.ok(d(`git fetch -q origin && git reset -q --hard ${r.base}`), 'reset hinter den Release');
  assert.ok(d(`cd ${r.repo} && git push origin main`), 'cd ins Repo');
});

test('offener Release: harmlose Befehle bleiben frei', () => {
  const r = setup();
  const d = (cmd) => decide(cmd, r.repo, r.repo);
  assert.equal(d('git status && git log --oneline -3'), null);
  assert.equal(d('git commit -q -m "fix; git push origin main"'), null, 'Message erwähnt push');
  assert.equal(d('git rebase --abort'), null);
  assert.equal(d('git reset --hard'), null, 'reset auf HEAD');
  assert.equal(d(`git reset -q --hard ${r.release}`), null, 'reset auf den Release selbst');
  assert.equal(d('git reset -- b.txt'), null, 'Pfad-Reset');
  assert.equal(d('git push origin v1.0.0'), null, 'Tag-Push');
  assert.equal(d(`cd ${r.other} && git push origin main`), null, 'anderes Repo');
  assert.equal(d(`git -C ${r.other} push origin main`), null, 'anderes Repo per -C');
});

test('amend nur auf dem Release-Commit selbst blockiert', () => {
  const r = setup();
  assert.equal(decide('git commit --amend --no-edit', r.repo, r.repo), null, 'HEAD ist der Fix');
  sh(r.repo, 'reset', '-q', '--hard', r.release);
  assert.ok(decide('git commit --amend --no-edit', r.repo, r.repo));
  assert.equal(decide('git commit -q -m "Hook blockt --amend auf ihn" -- a.txt', r.repo, r.repo), null, 'Message erwähnt --amend');
});

test('nach dem Tag ist der Release nicht mehr offen: Release-Push frei', () => {
  const r = setup();
  sh(r.repo, 'tag', '-a', 'v1.0.1', r.release, '-m', 'v1.0.1');
  const d = (cmd) => decide(cmd, r.repo, r.repo);
  assert.equal(d(`git push origin ${r.release}:refs/heads/main`), null);
  assert.equal(d('git push origin v1.0.1'), null);
  assert.equal(d('git push origin main'), null, 'Fix nach getaggtem Release');
});

test('Tag deckt einen späteren Commit derselben Version (Nachbesserung)', () => {
  const r = setup();
  const nach = commit(r.repo, 'c.txt', 'release: v1.0.1 (Nachbesserung)');
  assert.ok(decide('git push origin main', r.repo, r.repo), 'beide offen');
  sh(r.repo, 'tag', '-a', 'v1.0.1', nach, '-m', 'v1.0.1');
  assert.equal(decide(`git push origin ${nach}:refs/heads/main`, r.repo, r.repo), null);
});

test('späterer Versions-Tag deckt einen liegengebliebenen Release darunter', () => {
  const r = setup();
  const next = commit(r.repo, 'VERSION', 'release: v1.0.2');
  sh(r.repo, 'tag', '-a', 'v1.0.2', next, '-m', 'v1.0.2');
  assert.equal(decide(`git push origin ${next}:refs/heads/main`, r.repo, r.repo), null);
});

test('ohne offenen Release greift nichts', () => {
  const r = setup();
  sh(r.repo, 'push', '-q', 'origin', 'main');
  assert.equal(decide('git push origin main', r.repo, r.repo), null);
  assert.equal(decide(`git rebase origin/main`, r.repo, r.repo), null);
});

test('pushesMain: Refspec-Formen', () => {
  assert.equal(pushesMain(['origin', 'v1.2.3']), false);
  assert.equal(pushesMain(['origin', '--tags']), false);
  assert.equal(pushesMain(['origin', 'abc:refs/heads/main']), true);
  assert.equal(pushesMain(['origin', '+HEAD']), true);
  assert.equal(pushesMain(['origin', ':main']), true);
  assert.equal(pushesMain(['origin', 'feature:feature']), false);
});
