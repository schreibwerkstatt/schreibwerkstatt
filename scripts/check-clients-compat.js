#!/usr/bin/env node
'use strict';
// Breaking-Change-Prüfung des OTA-Editor-Bundles gegen die nativen Clients:
//   • macOS   — github.com/schreibwerkstatt/focuseditor (WKWebView-Schale)
//   • Android — github.com/schreibwerkstatt/mobile      (WebView-Schreibmodus)
//
// Massstab ist NICHT „hat der Client jedes neue Feature" — was neu ins Bundle
// kommt, lädt er beim nächsten Deploy einfach mit. Geprüft wird, ob etwas
// wegfällt oder umbenannt wird, auf das der Client-Code sich verlässt: Glue-
// Skripte und Host-CSS-Overrides (macOS als Strings in Swift, Android als
// host.html + editor-host.css + Kotlin-Strings) greifen auf Module, Exporte,
// Optionen, Handle-/Host-/Controller-Felder, Klassen, CSS-Variablen, Highlight-
// Namen, Manifest-Felder und das Bridge-Objekt des Editors zu.
//
// Die Kontaktstellen werden bei jedem Lauf frisch aus den Client-Repos gezogen,
// nicht hier abgeschrieben — eine Liste im Hauptrepo veraltet, sobald ein Client
// eine neue Override-Schicht bekommt. Dass die Kontaktstellen der Hervorhebung
// nicht nur existieren, sondern WIRKEN, prüft tests/e2e/_helpers/focus-client-contract.js
// (Chromium + WebKit).
//
//   node scripts/check-clients-compat.js                    # beide Clients, je main + neuester Release-Tag, Repos in ~/.cache holen/aktualisieren
//   node scripts/check-clients-compat.js --client android   # nur einer (mac | android)
//   node scripts/check-clients-compat.js --repo <pfad>      # vorhandener Checkout statt main + Release (nur mit --client)
//   node scripts/check-clients-compat.js --offline          # Cache ohne Pull
//   node scripts/check-clients-compat.js --base <ref>       # „berührt"-Liste gegen <ref> (Default HEAD)
//   node scripts/check-clients-compat.js --verbose          # alle Kontaktstellen auflisten
//   node scripts/check-clients-compat.js --write-surface    # contract/editor-surface.json ergänzen (--prune: neu statt ergänzen)
//   SW_MAC_REPO=… SW_ANDROID_REPO=…                         # lokale Checkouts statt ~/.cache (ungepushte Client-Stände)
//
// Exit 1, wenn bei einem Client eine Kontaktstelle fehlt. Die Liste „berührt"
// (Kontaktstelle existiert noch, eine Datei mit ihr ist geändert) bricht nicht
// ab: dort kann sich die Semantik verschoben haben, ohne dass ein Name fehlt —
// die Stellen sind von Hand gegen den Client-Code zu lesen. „Undeklariert"
// (der Client benutzt etwas, das nicht in contract/editor-surface.json steht)
// warnt nur: der Client ist dann auf einer Stelle, die der Server ohne Warnung
// ändern darf — Fläche bewusst erweitern (--write-surface) oder den Client auf
// eine deklarierte Stelle umstellen. Exit 3: ein Client-Repo war nicht
// erreichbar (CI wertet das als Warnung, nicht als Bruch).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { KINDS, clientSources, loadBundle, checkClient, requiredBridge } = require('./client-surface');
const { EDITOR_API } = require('../lib/client-contract');

const ROOT = path.resolve(__dirname, '..');
const SURFACE = path.join(ROOT, 'contract', 'editor-surface.json');

const CLIENTS = {
  mac: { label: 'macOS', repo: 'schreibwerkstatt/focuseditor', roots: ['schreibwerkstatt-focuseditor'] },
  android: { label: 'Android', repo: 'schreibwerkstatt/mobile', roots: ['app/src/main'] },
};

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] || '');
}
const has = (name) => process.argv.includes(name);
const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

const cacheDir = (name) => path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'schreibwerkstatt', name);
const repoUrl = (client) => `https://github.com/${client.repo}.git`;

// Öffentliche Repos: plain git statt `gh`, damit CI ohne Login klont.
function clone(client, dir, ref) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const args = ['clone', '--depth', '1', '-q', '-c', 'advice.detachedHead=false'];
  if (ref) args.push('--branch', ref);
  execFileSync('git', [...args, repoUrl(client), dir], { stdio: 'inherit' });
}

// Neuester Release-Tag (`v…`, Versions-Sortierung) — ohne GitHub-API, damit
// CI ohne Login auskommt. Offline: der Tag des zuletzt geholten Release-Caches.
function latestTag(client, dir) {
  if (has('--offline')) {
    try { return git(['describe', '--tags', '--exact-match'], dir).trim(); } catch { return null; }
  }
  const out = execFileSync('git', ['-c', 'versionsort.suffix=-', 'ls-remote', '--tags', '--refs', '--sort=-v:refname', repoUrl(client), 'v*'],
    { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const m = out.match(/refs\/tags\/(\S+)/);
  return m ? m[1] : null;
}

// Geprüft werden je Client zwei Stände: `main` (was als Nächstes ausgeliefert
// wird) und der neueste Release-Tag (was auf den Geräten läuft — beim macOS-
// Client liegen die oft Wochen auseinander). Ein expliziter Checkout
// (--repo / SW_*_REPO) ersetzt beide.
function checkouts(id, client) {
  const explicit = arg('--repo') || process.env[`SW_${id.toUpperCase()}_REPO`];
  if (explicit) return [{ ref: null, dir: path.resolve(explicit) }];
  const mainDir = cacheDir(`client-${id}`);
  const relDir = cacheDir(`client-${id}-release`);
  const out = [];
  try {
    if (!fs.existsSync(path.join(mainDir, '.git'))) clone(client, mainDir);
    else if (!has('--offline')) git(['pull', '--ff-only', '-q'], mainDir);
    out.push({ ref: 'main', dir: mainDir });

    const tag = latestTag(client, relDir);
    if (!tag) { console.log(`${client.label}: kein Release-Tag gefunden — nur main geprüft.`); return out; }
    let cached = null;
    try { cached = git(['describe', '--tags', '--exact-match'], relDir).trim(); } catch { /* kein Cache */ }
    if (cached !== tag) {
      fs.rmSync(relDir, { recursive: true, force: true });
      clone(client, relDir, tag);
    }
    // Zeigt der Tag auf denselben Commit wie main, wäre der zweite Lauf ein Duplikat.
    if (git(['rev-parse', 'HEAD'], relDir) === git(['rev-parse', 'HEAD'], mainDir)) out[0].ref = `main = ${tag}`;
    else out.push({ ref: tag, dir: relDir });
  } catch (e) {
    console.error(`${client.label}: Repo nicht erreichbar (${e.message.split('\n')[0]})`);
    process.exit(3);
  }
  return out;
}

function loadSurface() {
  return fs.existsSync(SURFACE) ? JSON.parse(fs.readFileSync(SURFACE, 'utf8')) : null;
}

const declared = (surface, c) => c.kind === 'bridgeRequired'
  ? surface.bridgeRequired.includes(c.name)
  : !!surface.surface[c.kind]?.[c.name];

// Deklarierte Fläche = Vereinigung aller genutzten Kontaktstellen beider
// Clients, je Eintrag mit den Clients, die ihn nutzen. Bewusster Schritt nach
// einer gewollten Erweiterung — nicht automatisch bei jedem Lauf.
//
// Schreiben ERGÄNZT nur: was ein Client nicht mehr anfasst, nutzt eine schon
// ausgelieferte Version oft noch (Store-Review, Geräte ohne Update). Entfernt
// wird erst mit `--prune`, wenn der Admin-Tab «Geräte» keine alte Version mehr
// zeigt (contract/README.md, Regel 2).
function writeSurface(results, b) {
  const prev = has('--prune') ? null : loadSurface();
  const surface = Object.fromEntries(KINDS.map((k) => [k.id, { ...(prev?.surface?.[k.id] || {}) }]));
  for (const { id, checks } of results) {
    for (const c of checks) {
      if (c.kind === 'bridgeRequired' || !c.ok) continue;
      surface[c.kind][c.name] = [...(surface[c.kind][c.name] || []), id];
    }
  }
  for (const k of Object.keys(surface)) {
    surface[k] = Object.fromEntries(Object.entries(surface[k]).sort(([x], [y]) => x.localeCompare(y)).map(([n, ids]) => [n, [...new Set(ids)].sort()]));
  }
  const out = {
    $comment: 'Deklarierte Kontaktstellen des OTA-Editor-Bundles (contract/README.md). Erzeugt mit `npm run contract:surface`; geprüft von tests/unit/editor-surface.test.js.',
    editorApi: EDITOR_API,
    bridgeRequired: requiredBridge(b),
    surface,
  };
  fs.writeFileSync(SURFACE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`\ncontract/editor-surface.json geschrieben (${Object.values(surface).reduce((n, m) => n + Object.keys(m).length, 0)} Kontaktstellen).`);
}

// Prüft einen Checkout eines Clients und druckt den Befund.
function checkTarget(client, ref, repo, b, changed, surface) {
  const commit = git(['log', '-1', '--format=%h %cs %s'], repo).trim();
  const checks = checkClient(clientSources(repo, client), b);
  const missing = checks.filter((c) => !c.ok);
  const touched = checks.filter((c) => c.ok && c.files.some((f) => changed.has(f)));
  const undeclared = surface ? checks.filter((c) => c.ok && !declared(surface, c)) : [];

  console.log(`\n━━ ${client.label}${ref ? ` [${ref}]` : ''}: ${client.repo} @ ${commit}`);
  console.log(`Kontaktstellen: ${checks.length}`);
  if (has('--verbose')) {
    for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label.padEnd(22)} ${c.name.padEnd(36)} ${c.at}`);
  }
  if (touched.length) {
    console.log(`BERÜHRT — existiert noch, Datei geändert; Semantik gegen den Client-Code lesen (${touched.length}):`);
    for (const c of touched) {
      console.log(`  ${c.label.padEnd(22)} ${c.name.padEnd(36)} ${c.at}  ↔  ${c.files.filter((f) => changed.has(f)).join(', ')}`);
    }
  }
  if (undeclared.length && !has('--write-surface')) {
    console.log(`UNDEKLARIERT — nicht in contract/editor-surface.json (${undeclared.length}):`);
    for (const c of undeclared) console.log(`  ${c.label.padEnd(22)} ${c.name.padEnd(36)} ${c.at}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::warning::${client.label}${ref ? ` [${ref}]` : ''} nutzt ${undeclared.length} nicht deklarierte Kontaktstelle(n) des Editor-Bundles`);
  }
  if (missing.length) {
    console.log(`FEHLT — Breaking Change für ${client.label} (${missing.length}):`);
    for (const c of missing) console.log(`  ${c.label.padEnd(22)} ${c.name.padEnd(36)} ${c.at}`);
  } else {
    console.log('Keine fehlende Kontaktstelle.');
  }
  return { checks, missing };
}

async function main() {
  const only = arg('--client');
  if (only && !CLIENTS[only]) { console.error(`Unbekannter Client: ${only} (mac | android)`); process.exit(2); }
  if (arg('--repo') && !only) { console.error('--repo nur zusammen mit --client'); process.exit(2); }

  const b = await loadBundle();
  const base = arg('--base') || 'HEAD';
  // Die „berührt"-Liste ist nur ein Hinweis: ist `base` nicht auflösbar
  // (flacher CI-Checkout), fällt sie leer aus, statt den Lauf abzubrechen.
  let diffNames = '';
  try { diffNames = git(['diff', '--name-only', base, '--', 'public']); }
  catch { console.log(`Basis ${base} nicht auflösbar — „berührt"-Liste entfällt.`); }
  const changed = new Set([
    ...diffNames.split('\n'),
    ...git(['ls-files', '--others', '--exclude-standard', '--', 'public']).split('\n'),
  ].filter(Boolean).map((f) => f.replace(/^public\//, '')));
  const changedBundle = b.bundleFiles.filter((f) => changed.has(f));
  console.log(`Bundle-Dateien geändert gegen ${base}: ${changedBundle.length ? changedBundle.join(', ') : '—'}`);

  if (has('--write-surface') && only) { console.error('--write-surface braucht beide Clients'); process.exit(2); }
  const surface = loadSurface();
  const results = [];
  let failed = false;
  for (const [id, client] of Object.entries(CLIENTS)) {
    if (only && only !== id) continue;
    for (const { ref, dir } of checkouts(id, client)) {
      const { checks, missing } = checkTarget(client, ref, dir, b, changed, surface);
      results.push({ id, checks });
      if (missing.length) failed = true;
    }
  }
  if (has('--write-surface')) writeSurface(results, b);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
