#!/usr/bin/env node
'use strict';
// Generates public/sw-manifest.js — the coherent shell-asset set the Service
// Worker precaches ATOMICALLY at install. Each generation's SHELL_CACHE is
// derived from a content hash over exactly these files, so any asset change
// produces a new generation (no manual SHELL_CACHE bump). The SW serves these
// assets cache-only (never a cross-generation network copy), which closes the
// skew where an old running JS module receives a freshly-fetched new partial.
//
// Coherence-critical set = app HTML partials + app JS modules + app CSS +
// i18n JSON + the Lucide icon sprite. Deliberately EXCLUDED:
//   - vendor/ (Alpine, jsMind, vis-network, Chart.js, …): self-contained,
//     version-stable, large — a skew there cannot reference app card fields,
//     so plain cache-first-with-fallback stays fine.
//   - fonts/ (large binaries), images, plausible-init.js (server-rendered,
//     must never be cached), the SW files themselves.
//
// Separately listed (NOT hashed, NOT precached): __VENDOR_SET, every file under
// vendor/ + fonts/. The SW's VENDOR_CACHE is generation-independent (it survives
// deploys on purpose); on activate the SW drops entries whose path is no longer
// in this set, so a replaced vendor version (new file name) does not linger in
// the cache forever. Not part of the build hash: a vendor swap always changes
// its referrer (index.html / lazy-libs.js), which is hashed already.
//
// Drift between the committed file and a fresh scan is gated by
// tests/unit/sw-manifest-drift.test.mjs. Regenerate via `npm run sw:manifest`
// (also runs automatically on `prestart`).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BUNDLE_URL_PREFIX } = require('../lib/bundle');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const TARGET = path.join(PUBLIC, 'sw-manifest.js');

// Directories under public/ to scan, with the extensions that count as
// coherence-critical shell assets.
const SCAN = [
  { dir: 'partials', exts: ['.html'] },
  { dir: 'js',       exts: ['.js', '.mjs', '.json'] },
  { dir: 'css',      exts: ['.css'] },
];

// Single files (relative to public/) always included.
const EXTRA_FILES = ['icons.svg'];

// Excluded by exact public-relative path: dynamic or self-referential assets.
const EXCLUDE = new Set([
  'js/plausible-init.js',      // server-rendered from app_settings; never cache
  'js/jsconfig.json',          // Editor-/LSP-Config, nie vom Browser geladen
  'js/tsconfig.check.json',    // Import-Gate-Config (npm run test:imports), nie vom Browser geladen
  'sw.js',
  'sw-manifest.js',
]);

function walk(dir, exts, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, exts, out);
    } else if (ent.isFile() && exts.includes(path.extname(ent.name))) {
      out.push(full);
    }
  }
  return out;
}

// Collects the coherence-critical files as sorted, root-relative URL paths
// (e.g. "/js/app.js") plus their absolute disk paths.
function collectFiles() {
  const abs = [];
  for (const { dir, exts } of SCAN) walk(path.join(PUBLIC, dir), exts, abs);
  for (const rel of EXTRA_FILES) {
    const full = path.join(PUBLIC, rel);
    if (fs.existsSync(full)) abs.push(full);
  }
  return abs
    .map((full) => {
      const rel = path.relative(PUBLIC, full).split(path.sep).join('/');
      return { rel, url: '/' + rel, full };
    })
    .filter((f) => !EXCLUDE.has(f.rel))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

// Version-stable assets (vendor/*, fonts/*) as sorted root-relative URL paths,
// every file type (Leaflet ships images + CSS in its own directory).
const VENDOR_DIRS = ['vendor', 'fonts'];
function collectVendorUrls() {
  const out = [];
  for (const dir of VENDOR_DIRS) {
    const abs = [];
    (function walkAll(d) {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const full = path.join(d, ent.name);
        if (ent.isDirectory()) walkAll(full);
        else if (ent.isFile()) abs.push(full);
      }
    })(path.join(PUBLIC, dir));
    for (const full of abs) out.push('/' + path.relative(PUBLIC, full).split(path.sep).join('/'));
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// Content hash over every file (path + bytes), so renaming or editing any
// asset shifts the build id and therefore the SHELL_CACHE generation.
// index.html is navigate-served (not precached) but folded in too, so an
// index-only change (e.g. a new <link>) still bumps the generation.
function buildHash(files, indexPath = path.join(PUBLIC, 'index.html')) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f.url);
    h.update('\0');
    h.update(fs.readFileSync(f.full));
    h.update('\0');
  }
  try {
    h.update('::index.html::');
    h.update(fs.readFileSync(indexPath));
  } catch { /* fehlt → ignorieren */ }
  return h.digest('hex').slice(0, 16);
}

// Prod-Bündel (scripts/build-bundle.js): die ins Bündel eingebauten Module und
// Stylesheets fallen aus dem Satz, die Bündel-Dateien kommen hinein (ohne
// Sourcemaps — die lädt nur DevTools). Alles andere bleibt: klassische Scripts
// aus index.html, Partials, i18n, Icon-Sprite. Geschrieben wird diese Fassung
// nur ins Bündel selbst (dist/sw-manifest.js, ausgeliefert von lib/bundle.js),
// nie nach public/ — das eingecheckte Manifest bleibt die Einzeldatei-Fassung.
function bundleFiles(bundle) {
  const built = new Set(bundle.build.inputs
    .filter((i) => i.startsWith('public/') && i !== 'public/index.html')
    .map((i) => i.slice('public/'.length)));
  const kept = collectFiles().filter((f) => !built.has(f.rel));
  const prefix = BUNDLE_URL_PREFIX;
  const own = bundle.build.files
    .filter((u) => u.startsWith(prefix) && !u.endsWith('.map'))
    .map((u) => ({ rel: null, url: u, full: path.join(bundle.dir, u.slice(prefix.length)) }));
  return [...kept, ...own].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

function renderManifest({ bundle = null } = {}) {
  const files = bundle ? bundleFiles(bundle) : collectFiles();
  const build = buildHash(files, bundle ? bundle.indexPath : undefined);
  const urls = files.map((f) => f.url);
  const list = urls.map((u) => `  ${JSON.stringify(u)},`).join('\n');
  const vendorUrls = collectVendorUrls();
  const vendorList = vendorUrls.map((u) => `  ${JSON.stringify(u)},`).join('\n');
  const content = `// GENERATED by scripts/sw-manifest.js — DO NOT EDIT BY HAND.
// Regenerate via \`npm run sw:manifest\` (runs automatically on prestart).
// Drift gated by tests/unit/sw-manifest-drift.test.mjs.
//
// __SHELL_BUILD: content hash over all listed assets → drives SHELL_CACHE.
// __SHELL_MANIFEST: the coherent set precached atomically at SW install.
// __VENDOR_SET: current vendor/ + fonts/ files — VENDOR_CACHE prune list.
self.__SHELL_BUILD = ${JSON.stringify(build)};
self.__SHELL_MANIFEST = [
${list}
];
self.__VENDOR_SET = [
${vendorList}
];
`;
  return { build, urls, vendorUrls, content };
}

function main() {
  const { build, urls, content } = renderManifest();
  const prev = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : null;
  if (prev === content) {
    console.log(`sw-manifest: unchanged (build ${build}, ${urls.length} assets).`);
    return;
  }
  fs.writeFileSync(TARGET, content);
  console.log(`sw-manifest: wrote ${path.relative(ROOT, TARGET)} (build ${build}, ${urls.length} assets).`);
}

if (require.main === module) main();

module.exports = { renderManifest, collectFiles, collectVendorUrls };
