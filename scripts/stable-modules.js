'use strict';
// Die stabilisierten Module — EINE Definition fuer Umfang, Sonderpruefung und
// Fingerabdruck. Regel (fuer alle gleich): docs/stabilisiert.md.
//
// Umfang je Modul = Code-Pfade (Kriterium: der Pfad entscheidet ueber das
// Verhalten des Moduls) + Tests. Tests zaehlen mit — ein gelockerter Assert ist
// dieselbe Verhaltensaenderung wie ein geaenderter Filter. Tests eines Moduls
// sind (a) die Testdateien mit dem Modulnamen, (b) jede Testdatei, die die
// Moduldoku verlinkt (was die Doku als «gegated» nennt, laeuft in der
// Sonderpruefung mit), (c) explizite Zusaetze.

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CODE_ROOTS = /^(routes|lib|db|public\/js|public\/css|public\/partials)\//;
const TEST_FILE = /^tests\/(unit|integration|e2e|e2e-app)\/[^/]+\.(test\.m?js|spec\.js)$/;

const MODULES = {
  lektorat: {
    title: 'Lektorat',
    docs: ['docs/lektorat.md'],
    codeName: /lektorat/i,
    codeExplicit: [
      'public/partials/editor-findings.html',   // Befundliste im Notebook-Editor
      'public/js/prompts/blocks.js',            // Regelbloecke des Lektorat-Prompts
      'public/js/prompts/blocks-fach.js',
      'public/js/prompts/blocks-welt.js',
      'public/js/prompts/state.js',             // JSON_ONLY
    ],
    testName: /lektorat/i,
    testExplicit: [
      'tests/integration/heatmap-loaders.test.js',
      'tests/e2e-app/fehler-heatmap.spec.js',
    ],
    appEngines: 'chromium',
  },
  focus: {
    title: 'Focus-Editor',
    docs: ['docs/focus-editor.md', 'docs/focus-editor-acceptance.md'],
    codeDirs: ['public/js/editor/focus/', 'public/css/editor/focus/'],
    codeExplicit: ['public/js/editor/focus.js', 'public/partials/editor-focus.html'],
    // Was der Focus-Pfad aus editor/shared/ zieht (transitiv) — eine Aenderung
    // dort trifft den Focus-Editor, auch wenn sie fuer den Notebook gedacht war.
    importClosure: { from: ['public/js/editor/focus.js', 'public/js/editor/focus/'], within: 'public/js/editor/shared/' },
    testName: /^(focus-|editor-focus\.)/,
    testExplicit: [],
    // Die App-Suite des Focus-Editors laeuft auch in Gecko (playwright.app.config.js).
    appEngines: 'chromium,firefox',
  },
  komplett: {
    title: 'Komplettanalyse',
    docs: ['docs/komplett.md'],
    codeName: /komplett|kontinuitaet|erzaehlprofil|entity-match|figuren-merge/i,
    codeDirs: ['routes/jobs/komplett/', 'public/js/prompts/komplett/', 'lib/entity-match/'],
    codeExplicit: [
      'routes/jobs/shared/chunking.js',  // splitGroupsIntoChunks, splitPageIntoParts
      'routes/jobs/shared/loader.js',    // chunkLimitsFor, resolveExtractSinglePassLimit
      'lib/name-normalize.js',
    ],
    testName: /komplett|kontinuitaet|erzaehlprofil|entity-match|figuren-/i,
    testExplicit: [],
    appEngines: 'chromium',
  },
};

function toRel(p) {
  const abs = path.resolve(ROOT, p);
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

let _allFiles = null;
function allFiles() {
  if (!_allFiles) {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    _allFiles = out.split('\n').filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f)));
  }
  return _allFiles;
}

function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; }
}

// Relative ESM-Imports transitiv verfolgen, solange das Ziel unter `within` liegt.
function importClosure({ from, within }, files) {
  const start = files.filter((f) => f.endsWith('.js') && from.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
  const seen = new Set();
  const queue = [...start];
  const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
  while (queue.length) {
    const cur = queue.shift();
    for (const m of read(cur).matchAll(IMPORT_RE)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(cur), m[1]));
      if (target.startsWith(within) && !seen.has(target) && fs.existsSync(path.join(ROOT, target))) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return [...seen];
}

function docLinkedTests(mod) {
  const out = new Set();
  for (const doc of mod.docs) {
    for (const m of read(doc).matchAll(/tests\/(?:unit|integration|e2e|e2e-app)\/[A-Za-z0-9._-]+/g)) {
      if (TEST_FILE.test(m[0]) && fs.existsSync(path.join(ROOT, m[0]))) out.add(m[0]);
    }
  }
  return out;
}

function listModuleFiles(name) {
  const mod = MODULES[name];
  if (!mod) throw new Error(`unbekanntes Modul «${name}» (bekannt: ${Object.keys(MODULES).join(', ')})`);
  const files = allFiles();
  const code = new Set(mod.codeExplicit || []);
  for (const f of files) {
    if (!CODE_ROOTS.test(f)) continue;
    if ((mod.codeDirs || []).some((d) => f.startsWith(d))) code.add(f);
    else if (mod.codeName && mod.codeName.test(path.posix.basename(f))) code.add(f);
  }
  if (mod.importClosure) for (const f of importClosure(mod.importClosure, files)) code.add(f);

  const tests = docLinkedTests(mod);
  for (const f of files) if (TEST_FILE.test(f) && mod.testName.test(path.posix.basename(f))) tests.add(f);
  for (const f of mod.testExplicit || []) tests.add(f);

  const exist = (f) => fs.existsSync(path.join(ROOT, f));
  return {
    code: [...code].filter(exist).sort(),
    tests: [...tests].filter(exist).sort(),
  };
}

function moduleOf(p) {
  const rel = toRel(p);
  return Object.keys(MODULES).filter((name) => {
    const { code, tests } = listModuleFiles(name);
    return code.includes(rel) || tests.includes(rel);
  });
}

// Fingerabdruck des Modul-Stands im Working Tree. Die Sonderpruefung schreibt
// ihn nach gruenem Lauf; `npm run stable:status` vergleicht.
function fingerprint(name) {
  const { code, tests } = listModuleFiles(name);
  const h = crypto.createHash('sha256');
  for (const rel of [...code, ...tests].sort()) {
    h.update(rel + '\0');
    try { h.update(fs.readFileSync(path.join(ROOT, rel))); } catch { h.update('<missing>'); }
    h.update('\0');
  }
  return h.digest('hex');
}

const stampFile = (name) => path.join(ROOT, 'tests', '.tmp', `stable-${name}.json`);

function readStamp(name) {
  try { return JSON.parse(fs.readFileSync(stampFile(name), 'utf8')); } catch { return null; }
}

function writeStamp(name, fp) {
  fs.mkdirSync(path.dirname(stampFile(name)), { recursive: true });
  fs.writeFileSync(stampFile(name), JSON.stringify({ fingerprint: fp, at: new Date().toISOString() }) + '\n');
}

module.exports = { ROOT, MODULES, listModuleFiles, moduleOf, fingerprint, readStamp, writeStamp, stampFile };
