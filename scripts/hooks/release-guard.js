#!/usr/bin/env node
'use strict';
// PreToolUse-Hook (Bash): ein Release gehört zwischen Commit und Tag dem
// /release-Befehl. «Offen» ist ein `release: vX.Y.Z`-Commit, der lokal vor
// origin/main liegt und noch in keinem Versions-Tag `v*` steckt — sein
// Schnappschuss wird gerade getestet ([.claude/commands/release.md]). Solange
// einer offen ist, blockt der Hook in DIESEM Repo:
//   • git push auf main — enthält der Push den Release-Commit, ginge er vor
//     dem grünen Test raus; enthält er ihn nicht, überholt ein Fremd-Commit den
//     Release und dessen Push wird abgewiesen. Der Release selbst taggt vor dem
//     Push, ist dann also nicht mehr offen.
//   • git rebase / git pull --rebase — schreibt den getesteten Commit um; der
//     neue SHA ist ungetestet und nicht taggbar.
//   • git reset auf einen Stand, der den Release-Commit nicht enthält.
//   • git commit --amend auf dem Release-Commit selbst.
// Tags pushen, andere Repos (cd/-C ausserhalb) und lesende Befehle bleiben frei.
// Block via Exit 2 + stderr. Regel: .claude/commands/release.md, „Offener Release".

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function realDir(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function insideRepo(dir, root) {
  const d = realDir(dir);
  const r = realDir(root);
  return !!d && !!r && (d === r || d.startsWith(r + path.sep));
}

/** Trennzeichen innerhalb von Quotes neutralisieren, damit eine Commit-Message
 *  wie "fix; git push" keinen eigenen Befehlsteil erzeugt. */
function maskQuoted(cmd) {
  return cmd.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (s) => s.replace(/[;&|\n]/g, ' '));
}

function unquote(s) {
  return s.replace(/^(['"])(.*)\1$/, '$2');
}

/** Zerlegt den Bash-Befehl in git-Aufrufe samt Arbeitsverzeichnis. */
function gitCalls(command, startDir) {
  const calls = [];
  let dir = startDir;
  for (const raw of maskQuoted(command).split(/;|&&|\|\||\||\n/)) {
    const part = raw.trim();
    const cd = part.match(/^cd\s+(\S+)\s*$/);
    if (cd) {
      const target = unquote(cd[1]).replace(/^~(?=$|\/)/, process.env.HOME || '~');
      dir = path.resolve(dir, target);
      continue;
    }
    const m = part.match(/^(?:\w+=\S*\s+)*git\s+((?:(?:-C\s+\S+|-c\s+\S+)\s+)*)(\w[\w-]*)\b(.*)$/);
    if (!m) continue;
    let callDir = dir;
    const cOpt = m[1].match(/-C\s+(\S+)/);
    if (cOpt) callDir = path.resolve(dir, unquote(cOpt[1]));
    // Quotierte Argumente bleiben ein Token: eine Message mit «--amend» ist kein Flag.
    const args = (m[3].match(/'[^']*'|"(?:[^"\\]|\\.)*"|\S+/g) || []).map(unquote);
    calls.push({ dir: callDir, sub: m[2], args });
  }
  return calls;
}

/** Offene Release-Commits: `release: vX.Y.Z` in origin/main..HEAD, die kein `v*`-Tag enthält. */
function openReleases(root) {
  const log = git(root, ['log', '--format=%H %s', 'origin/main..HEAD']);
  if (!log) return [];
  const open = [];
  for (const line of log.split('\n')) {
    const m = line.match(/^([0-9a-f]{40}) release: v(\d+\.\d+\.\d+)\b/);
    if (!m) continue;
    const [, sha, ver] = m;
    // Gedeckt ist er, sobald irgendein Versions-Tag ihn enthält — auch ein
    // späterer (v6.5.2 deckt einen liegengebliebenen v6.5.1-Commit darunter).
    const covered = git(root, ['tag', '--list', 'v*', '--contains', sha]);
    if (!covered) open.push({ sha, ver });
  }
  return open;
}

function resolveCommit(root, rev) {
  return git(root, ['rev-parse', '-q', '--verify', `${rev}^{commit}`]);
}

function contains(root, ancestor, rev) {
  return git(root, ['merge-base', '--is-ancestor', ancestor, rev]) !== null;
}

const MAIN_REFS = new Set(['main', 'refs/heads/main', 'HEAD']);

/** Liefert true, wenn der push-Aufruf main auf origin verändert. */
function pushesMain(args) {
  const positional = args.filter((a) => !a.startsWith('-'));
  if (args.includes('--tags') && positional.length <= 1) return false;
  if (args.some((a) => a === '--mirror' || a === '--all' || a === '--delete' || a === '-d')) return true;
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) return true; // `git push` / `git push origin` auf main
  return refspecs.some((spec) => {
    const s = spec.replace(/^\+/, '');
    if (s.includes(':')) return MAIN_REFS.has(s.split(':')[1]) || s.split(':')[1] === '';
    return MAIN_REFS.has(s);
  });
}

/** Prüft einen git-Aufruf gegen die offenen Releases; liefert Grund oder null. */
function checkCall(call, open, root) {
  const { sub, args } = call;
  const shown = `git ${sub} ${args.join(' ')}`.trim();
  if (sub === 'push') {
    if (pushesMain(args)) return `\`${shown}\` schiebt main, während der Release offen ist.`;
    return null;
  }
  if (sub === 'rebase') {
    if (args.some((a) => a === '--abort' || a === '--quit')) return null;
    return `\`${shown}\` schreibt den Release-Commit um — der neue SHA ist ungetestet und nicht taggbar.`;
  }
  if (sub === 'pull') {
    const rebaseCfg = git(root, ['config', '--get', 'pull.rebase']);
    const rebasing = args.some((a) => a === '--rebase' || a === '-r' || a.startsWith('--rebase='))
      || (rebaseCfg && rebaseCfg !== 'false' && !args.includes('--no-rebase'));
    if (rebasing) return `\`${shown}\` rebaset den Release-Commit.`;
    return null;
  }
  if (sub === 'reset') {
    const dashdash = args.indexOf('--');
    const head = dashdash === -1 ? args : args.slice(0, dashdash);
    const target = head.find((a) => !a.startsWith('-'));
    if (!target) return null;
    const sha = resolveCommit(root, target);
    if (!sha) return null; // Pfad, kein Commit
    const lost = open.filter((r) => !contains(root, r.sha, sha));
    if (lost.length) return `\`${shown}\` setzt main hinter den Release-Commit zurück.`;
    return null;
  }
  if (sub === 'commit' && args.includes('--amend')) {
    const headSha = resolveCommit(root, 'HEAD');
    if (open.some((r) => r.sha === headSha)) return `\`${shown}\` ändert den Release-Commit selbst.`;
    return null;
  }
  return null;
}

const RELEVANT = new Set(['push', 'rebase', 'pull', 'reset', 'commit']);

/** Kern: Grund für eine Blockade oder null. Exportiert für den Unit-Test. */
function decide(command, cwd, root = REPO_ROOT) {
  const calls = gitCalls(command, cwd || root)
    .filter((c) => RELEVANT.has(c.sub) && insideRepo(c.dir, root));
  if (!calls.length) return null;
  const open = openReleases(root);
  if (!open.length) return null;
  for (const call of calls) {
    const reason = checkCall(call, open, root);
    if (reason) {
      const list = open.map((r) => `${r.sha.slice(0, 8)} release: v${r.ver}`).join(', ');
      return `${reason}\nOffener Release (noch ohne Tag): ${list}.\n`
        + 'Bis /release getaggt und gepusht hat, gehört dieser Commit dem Release-Lauf. '
        + 'Eigene Änderungen lokal auf ihm committen — sie gehen danach mit dem nächsten Push raus. '
        + 'Ist der Release-Lauf rot/abgebrochen: nachbessern und /release erneut starten (setzt über Schritt 2 auf). '
        + 'Bewusst übergehen darf das nur der User selbst im Terminal.';
    }
  }
  return null;
}

module.exports = { decide, pushesMain, gitCalls };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    let payload;
    try { payload = JSON.parse(raw || '{}'); } catch { process.exit(0); }
    if (payload.tool_name !== 'Bash' || typeof payload.tool_input?.command !== 'string') process.exit(0);
    const reason = decide(payload.tool_input.command, payload.cwd);
    if (reason) {
      process.stderr.write('[release-guard] blockiert: ' + reason +
        '\nRegel: .claude/commands/release.md, „Offener Release".\n');
      process.exit(2);
    }
    process.exit(0);
  });
}
