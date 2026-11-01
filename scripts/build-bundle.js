#!/usr/bin/env node
'use strict';
// Baut das Prod-Bündel der SPA-Shell nach dist/ (oder BUNDLE_DIR / --out):
//   - JS: die Modul-Einstiege aus public/index.html (app.js, tooltip.js) mit
//     Code-Splitting; die dynamischen import() bleiben eigene Chunks.
//   - CSS: alle Stylesheets aus public/index.html in ihrer Reihenfolge als EINE
//     Datei (die @layer-Reihenfolge legt tokens.css als erstes fest).
//   - index.html: dieselbe Shell, nur mit Bündel statt Einzeldateien und ohne
//     die modulepreload-Liste.
//   - build.json: Quell-Hash + Dateiliste, gelesen von lib/bundle.js.
//
// Why: ~1000 parallele Requests pro Boot machten jeden Aussetzer im Browser
// zum Boot-Ausfall (ein fehlendes Modul reisst den ganzen Graphen mit). Dev,
// Tests und das OTA-Editor-Bundle der nativen Clients bleiben bei den
// Einzeldateien; gebaut wird nur für Prod (deploy/deploy.sh).
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { BUNDLE_URL_PREFIX, BUILD_FILE, SW_MANIFEST_FILE, sourceHash } = require('../lib/bundle');
const { renderManifest } = require('./sw-manifest');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

function outDirFromArgs() {
  const i = process.argv.indexOf('--out');
  if (i > 0 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  return path.resolve(process.env.BUNDLE_DIR || path.join(ROOT, 'dist'));
}

const STYLESHEET_RE = /^[ \t]*<link rel="stylesheet" href="(css\/[^"]+\.css)">[ \t]*\r?\n/gm;
const MODULEPRELOAD_RE = /^[ \t]*<link rel="modulepreload" href="js\/[^"]+">[ \t]*\r?\n/gm;
const CSS_STDIN_NAME = 'index-stylesheets.css';
const MODULE_ENTRY_RE = /<script type="module" src="(js\/[^"]+\.js)"><\/script>/g;

// Eingaben, die das Bündel tragen, relativ zu ROOT (gleiche Form wie esbuilds
// metafile.inputs, damit lib/bundle.js denselben Hash nachrechnen kann).
function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }

async function build() {
  // In ein Nachbarverzeichnis bauen und erst am Ende tauschen: auf Prod läuft
  // der alte Server bis zum Neustart weiter und liest seine Dateien von der Platte.
  const finalDir = outDirFromArgs();
  const outDir = `${finalDir}.building`;
  const indexSrc = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

  const cssHrefs = [...indexSrc.matchAll(STYLESHEET_RE)].map(m => m[1]);
  const entries = [...indexSrc.matchAll(MODULE_ENTRY_RE)].map(m => m[1]);
  if (!cssHrefs.length) throw new Error('index.html: keine Stylesheets gefunden — Format geändert?');
  if (!entries.includes('js/app.js')) throw new Error('index.html: Modul-Einstieg js/app.js fehlt — Format geändert?');

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const common = {
    bundle: true,
    outdir: outDir,
    metafile: true,
    sourcemap: 'linked',
    legalComments: 'none',
    // Nur Whitespace/Syntax: Namen bleiben, damit Stacks in js_errors lesbar sind.
    minifyWhitespace: true,
    minifySyntax: true,
    keepNames: true,
    target: 'esnext',
    logLevel: 'warning',
    absWorkingDir: ROOT,
  };

  const js = await esbuild.build({
    ...common,
    entryPoints: entries.map(e => path.join(PUBLIC, e)),
    format: 'esm',
    splitting: true,
    entryNames: '[name]-[hash]',
    chunkNames: 'chunk-[hash]',
  });

  // Schriften liegen unter public/fonts und werden dort weiter ausgeliefert
  // (generationsunabhängiger Vendor-Cache des SW) — nicht ins Bündel kopieren.
  const css = await esbuild.build({
    ...common,
    stdin: {
      contents: cssHrefs.map(h => `@import "./${h}";`).join('\n'),
      resolveDir: PUBLIC,
      sourcefile: CSS_STDIN_NAME,
      loader: 'css',
    },
    entryNames: 'app-[hash]',
    external: ['*.woff2'],
  });

  const outputs = { ...js.metafile.outputs, ...css.metafile.outputs };
  const urlOf = (abs) => BUNDLE_URL_PREFIX + rel(abs).slice(rel(outDir).length + 1);
  const entryUrl = {};
  for (const [out, meta] of Object.entries(js.metafile.outputs)) {
    if (meta.entryPoint) entryUrl[meta.entryPoint.replace(/^public\//, '')] = urlOf(path.join(ROOT, out));
  }
  const cssOut = Object.keys(css.metafile.outputs).find(o => o.endsWith('.css'));
  if (!cssOut) throw new Error('esbuild: keine CSS-Ausgabe');

  // index.html umschreiben: erstes Stylesheet → Bündel-CSS, Rest raus;
  // Preloads raus; Modul-Einstiege → Bündel-Einstiege.
  let firstCss = true;
  let html = indexSrc.replace(STYLESHEET_RE, (line) => {
    if (!firstCss) return '';
    firstCss = false;
    return line.replace(/href="[^"]+"/, `href="${urlOf(path.join(ROOT, cssOut))}"`);
  });
  html = html.replace(MODULEPRELOAD_RE, '');
  html = html.replace(MODULE_ENTRY_RE, (tag, src) => {
    if (!entryUrl[src]) throw new Error(`esbuild: kein Ausgabe-Einstieg für ${src}`);
    return tag.replace(src, entryUrl[src]);
  });
  if (/href="css\/|rel="modulepreload"|src="js\/app\.js"/.test(html)) {
    throw new Error('index.html: Einzeldatei-Verweise nach dem Umschreiben übrig — Format geändert?');
  }
  fs.writeFileSync(path.join(outDir, 'index.html'), html);

  const bundled = [
    'public/index.html',
    ...Object.keys(js.metafile.inputs),
    ...Object.keys(css.metafile.inputs).filter(i => !i.endsWith(CSS_STDIN_NAME)),
  ];
  const files = Object.keys(outputs).map(o => urlOf(path.join(ROOT, o)));

  // SW-Manifest dieses Bündels (scripts/sw-manifest.js#bundleFiles). Es listet
  // neben den Bündel-Dateien auch Partials, i18n und klassische Scripts aus
  // public/ — die gehen darum mit in den Quell-Hash: ändert sich eine davon,
  // gilt das Bündel als veraltet, statt ein Manifest mit falschem Build-Hash
  // auszuliefern.
  const manifest = renderManifest({
    bundle: { dir: outDir, indexPath: path.join(outDir, 'index.html'), build: { files, inputs: bundled } },
  });
  fs.writeFileSync(path.join(outDir, SW_MANIFEST_FILE), manifest.content);
  const listed = manifest.urls.filter(u => !u.startsWith(BUNDLE_URL_PREFIX)).map(u => 'public' + u);
  const inputs = [...new Set([...bundled, ...listed])];

  const buildInfo = { sourceHash: sourceHash(ROOT, inputs), shellBuild: manifest.build, files, inputs };
  fs.writeFileSync(path.join(outDir, BUILD_FILE), JSON.stringify(buildInfo, null, 2) + '\n');

  const old = `${finalDir}.old`;
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(finalDir)) fs.renameSync(finalDir, old);
  fs.renameSync(outDir, finalDir);
  fs.rmSync(old, { recursive: true, force: true });

  const jsCount = files.filter(f => f.endsWith('.js')).length;
  console.log(`Bündel ${buildInfo.sourceHash} (SW-Build ${manifest.build}): ${jsCount} JS + 1 CSS, `
    + `${manifest.urls.length} Einträge im SW-Manifest → ${finalDir}`);
}

build().catch((e) => {
  console.error('✗ Bündel-Build gescheitert:', e.message);
  process.exit(1);
});
