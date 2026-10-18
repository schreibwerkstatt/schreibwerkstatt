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
//   node scripts/check-clients-compat.js                    # beide Clients, Repos in ~/.cache holen/aktualisieren
//   node scripts/check-clients-compat.js --client android   # nur einer (mac | android)
//   node scripts/check-clients-compat.js --repo <pfad>      # vorhandener Checkout (nur mit --client)
//   node scripts/check-clients-compat.js --offline          # Cache ohne Pull
//   node scripts/check-clients-compat.js --base <ref>       # „berührt"-Liste gegen <ref> (Default HEAD)
//   node scripts/check-clients-compat.js --verbose          # alle Kontaktstellen auflisten
//
// Exit 1, wenn bei einem Client eine Kontaktstelle fehlt. Die Liste „berührt"
// (Kontaktstelle existiert noch, eine Datei mit ihr ist geändert) bricht nicht
// ab: dort kann sich die Semantik verschoben haben, ohne dass ein Name fehlt —
// die Stellen sind von Hand gegen den Client-Code zu lesen.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildClosure, ENTRY_MODULES, CSS_FILES } = require('../lib/editor-bundle');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

const CLIENTS = {
  mac: { label: 'macOS', repo: 'schreibwerkstatt/focuseditor', roots: ['schreibwerkstatt-focuseditor'] },
  android: { label: 'Android', repo: 'schreibwerkstatt/mobile', roots: ['app/src/main'] },
};

// Markup, das ein Client selbst anlegt (Android-Toolbar: Checkliste). Nicht im
// Bundle, aber an den SSoT gebunden, den Notebook, Export und Server lesen.
const MARKUP_SSOT = ['js/editor/shared/todo-html.js'];

// Native Member, die zufällig `controller.`/`host.` heissen.
const NATIVE_NOISE = new Set(['addUserScript', 'addScriptMessageHandler', 'removeAllUserScripts',
  'removeScriptMessageHandler', 'removeAllScriptMessageHandlers', 'js', 'hasPrefix', 'isEmpty']);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] || '');
}
const has = (name) => process.argv.includes(name);
const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

function checkout(id, client) {
  const explicit = arg('--repo');
  if (explicit) return path.resolve(explicit);
  const dir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'schreibwerkstatt', `client-${id}`);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync('gh', ['repo', 'clone', client.repo, dir, '--', '--depth', '1', '-q'], { stdio: 'inherit' });
  } else if (!has('--offline')) {
    git(['pull', '--ff-only', '-q'], dir);
  }
  return dir;
}

// ── Quelltext der Clients ────────────────────────────────────────────────────
// `web` = was in der WebView landet: bei .swift/.kt nur der Inhalt von String-
// Literalen (Interpolation herausgenommen — die ist nativer Code), bei
// .html/.css/.js der ganze Text. `code` = alle Zeilen, für native Zugriffe
// (Manifest). Kommentarzeilen fallen weg: ein Kommentar, der einen alten Namen
// erwähnt, ist kein Zugriff.
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|<!--)/;
const noInterp = (t) => t
  .replace(/\\\((?:[^()]|\([^()]*\))*\)/g, ' ')    // Swift  \(…)
  .replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, ' ');   // Kotlin ${…}

function stringParts(lines) {
  const out = [];
  let inBlock = false;
  for (const { text, n } of lines) {
    const fences = (text.match(/"""/g) || []).length;
    if (inBlock) {
      if (fences % 2 === 1) { inBlock = false; continue; }
      if (!COMMENT_LINE.test(text)) out.push({ text: noInterp(text), n });
      continue;
    }
    if (fences % 2 === 1) { inBlock = true; continue; }
    if (COMMENT_LINE.test(text)) continue;
    const lits = [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    if (lits.length) out.push({ text: noInterp(lits.join(' ')), n });
  }
  return out;
}

// Block-Kommentare (`/* … */`, `<!-- … -->`) zeilenübergreifend entfernen —
// Zeilennummern bleiben erhalten.
function stripBlockComments(lines) {
  let open = null;
  return lines.map(({ text, n }) => {
    let out = '';
    let i = 0;
    while (i < text.length) {
      if (open) {
        const end = text.indexOf(open, i);
        if (end === -1) { i = text.length; break; }
        i = end + open.length; open = null; continue;
      }
      const c = text.indexOf('/*', i);
      const h = text.indexOf('<!--', i);
      const next = [c, h].filter((x) => x !== -1).sort((a, z) => a - z)[0];
      if (next === undefined) { out += text.slice(i); break; }
      out += text.slice(i, next);
      open = next === c ? '*/' : '-->';
      i = next + (open === '*/' ? 2 : 4);
    }
    return { text: out, n };
  }).filter(({ text }) => text.trim() && !/^\s*\/\//.test(text));
}

function clientSources(repo, client) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['build', 'test', 'androidTest', 'res'].includes(e.name)) walk(p); }
      else if (/\.(swift|kt|html|css|js)$/.test(e.name)) files.push(p);
    }
  };
  for (const r of client.roots) walk(path.join(repo, r));
  return files.map((file) => {
    const all = fs.readFileSync(file, 'utf8').split('\n').map((text, i) => ({ text, n: i + 1 }));
    const code = all.filter(({ text }) => !COMMENT_LINE.test(text));
    return {
      file: path.relative(repo, file),
      web: stripBlockComments(/\.(swift|kt)$/.test(file) ? stringParts(all) : all),
      code,
    };
  });
}

function collect(sources, re, pick, layer = 'web') {
  const found = new Map();
  for (const { file, [layer]: lines } of sources) {
    for (const { text, n } of lines) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        for (const name of [].concat(pick(m)).filter(Boolean)) {
          if (!found.has(name)) found.set(name, `${file}:${n}`);
        }
      }
    }
  }
  return found;
}

// Schlüssel der obersten Ebene eines Objekt-Literals ab `text[open] === '{'`.
function topLevelKeys(text, open) {
  const keys = [];
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if ('{[('.includes(ch)) {
      depth++;
      if (depth === 1 || ch !== '{') continue;
    }
    if ('}])'.includes(ch)) { depth--; if (depth === 0) break; continue; }
    if (depth === 1 && /[{,\n]/.test(text[i - 1] || '') === false && ch !== ',' && ch !== '\n') continue;
    if (depth === 1) {
      const m = /^[\s,]*([A-Za-z_$][\w$]*)\s*(?::|\(|,|\n|\})/.exec(text.slice(i + (ch === ',' || ch === '\n' ? 1 : 0)));
      if (m && !keys.includes(m[1]) && !['async', 'get', 'set'].includes(m[1])) keys.push(m[1]);
    }
  }
  return keys;
}

// Objekt-Literale, die der Client an eine Editor-Funktion übergibt, plus sein
// Bridge-Objekt. Liefert Map "fn.key" → Fundstelle.
function objectKeys(sources, fnNames) {
  const found = new Map();
  for (const { file, web } of sources) {
    const text = web.map((l) => l.text).join('\n');
    const lineAt = (i) => web[text.slice(0, i).split('\n').length - 1]?.n;
    const re = new RegExp(`\\b(${[...fnNames, 'bridge'].join('|')})\\s*(?:\\(\\s*|=\\s*)\\{`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const open = m.index + m[0].length - 1;
      for (const key of topLevelKeys(text, open)) {
        const name = `${m[1]}.${key}`;
        if (!found.has(name)) found.set(name, `${file}:${lineAt(m.index)}`);
      }
    }
  }
  return found;
}

// Zugriffe `<ns>.fn` auf einen Namespace aus `const <ns> = await import(…)`,
// begrenzt auf den umschliessenden Block der Bindung. Der Name ist frei (macOS:
// `const m = await import(url)` in `_merge3`) — global nach `m.` zu suchen träfe
// jedes Regex-Match-Objekt, darum nur bis zur schliessenden Klammer des Blocks.
function namespaceMembers(sources) {
  const found = new Map();
  for (const { file, web } of sources) {
    const text = web.map((l) => l.text).join('\n');
    const lineAt = (i) => web[text.slice(0, i).split('\n').length - 1]?.n;
    const bind = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(/g;
    let m;
    while ((m = bind.exec(text)) !== null) {
      let end = m.index;
      for (let depth = 0; end < text.length; end++) {
        if (text[end] === '{') depth++;
        else if (text[end] === '}' && --depth < 0) break;
      }
      const use = new RegExp(`(?<![\\w$.])${m[1].replace(/\$/g, '\\$')}\\.([A-Za-z_]\\w*)`, 'g');
      const scope = text.slice(m.index, end);
      let u;
      while ((u = use.exec(scope)) !== null) {
        if (!found.has(u[1])) found.set(u[1], `${file}:${lineAt(m.index + u.index)}`);
      }
    }
  }
  return found;
}

// ── Bundle ───────────────────────────────────────────────────────────────────
async function loadBundle() {
  const { files: jsFiles } = await buildClosure(ENTRY_MODULES);
  const bundleFiles = [...jsFiles, ...CSS_FILES];
  const text = new Map([...bundleFiles, ...MARKUP_SSOT].map((f) => [f, fs.readFileSync(path.join(PUBLIC, f), 'utf8')]));
  const jsText = jsFiles.map((f) => text.get(f)).join('\n');
  const exportedIn = (name) => jsFiles.filter((f) => new RegExp(
    `export\\s+(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(text.get(f)));
  return {
    jsFiles, bundleFiles, text, jsText, exportedIn,
    filesWith: (needle, extra = []) => [...bundleFiles, ...extra].filter((f) => text.get(f).includes(needle)),
    standalone: text.get('js/editor/focus/standalone.js'),
    bundleSrc: fs.readFileSync(path.join(ROOT, 'lib', 'editor-bundle.js'), 'utf8'),
  };
}

function checkClient(sources, b) {
  const checks = [];
  const add = (kind, map, ok, where = (name) => b.filesWith(name)) => {
    for (const [name, at] of map) checks.push({ kind, name, at, ok: ok(name), files: where(name) });
  };
  const webAll = sources.map((s) => s.web.map((l) => l.text).join('\n')).join('\n');

  // 1. Module, die der Client per Pfad lädt.
  add('Modul', collect(sources, /(?:import\(\s*|new URL\(\s*)['"](?:\.\/)?(js\/[^'"]+\.js)['"]/g, (m) => m[1]),
    (p) => b.jsFiles.includes(p), (p) => [p]);

  // 2. Exporte, die er daraus benutzt (Destrukturierung, `<x>Mod.fn`/`mod.fn`
  //    und `<ns>.fn` auf einem per `await import()` gebundenen Namespace).
  const exports = new Map([
    ...namespaceMembers(sources),
    ...collect(sources, /\{([^}]+)\}\s*=\s*await\s+import\(/g,
      (m) => m[1].split(',').map((s) => s.trim().split(/\s*:\s*/)[0])),
    ...collect(sources, /\b(?:mod|[a-z]\w*Mod)\.([A-Za-z_]\w*)/g, (m) => m[1]),
  ]);
  add('Export', exports, (n) => b.exportedIn(n).length > 0, (n) => b.exportedIn(n));

  // 3. Optionen an Editor-Funktionen + Felder des eigenen Bridge-Objekts.
  //    Optionen: Name muss im definierenden Modul (bzw. seinem Ordner) vorkommen.
  //    Bridge: was der Client mitgibt, muss der Editor noch lesen (`bridge.x`).
  const fnNames = [...exports.keys()].filter((n) => /^(mount|create)/.test(n));
  const opts = objectKeys(sources, fnNames);
  const optOk = (name) => {
    const [fn, key] = name.split('.');
    if (fn === 'bridge') return new RegExp(`\\bbridge\\.${key}\\b`).test(b.jsText);
    const dirs = b.exportedIn(fn).map((f) => path.posix.dirname(f));
    return b.jsFiles.some((f) => dirs.includes(path.posix.dirname(f)) && new RegExp(`\\b${key}\\b`).test(b.text.get(f)));
  };
  add('Option/Bridge-Feld', opts, optOk, (name) => {
    const [fn] = name.split('.');
    return fn === 'bridge' ? ['js/editor/focus/standalone.js'] : b.exportedIn(fn);
  });

  // 4. Handle-, Host- und Controller-Felder — auch Ketten wie
  //    `handle.controller._focusUpdateActive` und per defineProperty ersetzte
  //    Host-Felder (Android: Getter für `typewriterAnchor`).
  const member = (name) => new RegExp(`\\b${name}\\b`).test(b.jsText);
  add('Handle/Host/Controller', new Map([
    ...collect(sources, /(?<=(?<![\w/-])(?:__standalone|__swHandle|handle|host|controller)\??\.)([A-Za-z_]\w*)(?![\w-]*\.(?:html|css|js|json))/g,
      (m) => (NATIVE_NOISE.has(m[1]) || /^(html|css|js|json)$/.test(m[1]) ? null : m[1])),
    ...collect(sources, /defineProperty\(\s*host\s*,\s*['"](\w+)['"]/g, (m) => m[1]),
  ]), member);

  // 5. Klassen, die Host-CSS/Glue selektieren, setzen oder als Markup anlegen.
  //    Modifier wie `focus-mode--sentence` setzt der Editor zusammen
  //    (`'focus-mode--' + g`): Präfix im Bundle + Wert als String-Literal reicht.
  const modifierOk = (c) => {
    const i = c.indexOf('--');
    if (i < 1 || i + 2 >= c.length) return false;
    return b.filesWith(c.slice(0, i + 2)).length > 0 && new RegExp(`['"\`]${c.slice(i + 2)}['"\`]`).test(b.jsText);
  };
  add('Klasse', collect(sources,
    /(?<![\w-])((?:focus-(?:editor|mode|cursor|paragraph)|lt-|synonym-|figur-lookup|todo)[a-z0-9_-]*|is-active)(?![\w])/g,
    (m) => m[1]), (c) => b.filesWith(c, MARKUP_SSOT).length > 0 || modifierOk(c),
  (c) => b.filesWith(c, MARKUP_SSOT));

  // 6. CSS-Variablen des Editors (die eigenen `--sw-*` der Clients nicht).
  add('CSS-Variable', collect(sources, /(--(?:focus|color|opacity)-[a-z0-9-]+)/g, (m) => m[1]),
    (v) => b.filesWith(v).length > 0);

  // 7. Highlight-Namen (CSS Custom Highlight API).
  add('Highlight', collect(sources, /::highlight\(([\w-]+)\)/g, (m) => m[1]),
    (h) => b.filesWith(h).length > 0);

  // 8. Manifest-Felder (macOS liest sie nativ, Android in host.html).
  add('Manifest-Feld', new Map([
    ...collect(sources, /\bmanifest\??\.([A-Za-z_]\w*)(?!\s*\()/g, (m) => (m[1] === 'json' ? null : m[1]), 'code'),
  ]), (k) => new RegExp(`\\bmanifest\\s*=\\s*\\{[^}]*\\b${k}\\b`).test(b.bundleSrc), () => ['lib/editor-bundle.js']);

  // 9. Gegenrichtung: was der Editor vom Bridge-Objekt der Schale VERLANGT.
  for (const m of b.standalone.matchAll(/typeof bridge\.(\w+) !== 'function'/g)) {
    checks.push({ kind: 'Bridge (Pflicht)', name: m[1], at: 'js/editor/focus/standalone.js',
      ok: new RegExp(`\\b${m[1]}\\s*(?::|\\()`).test(webAll), files: [] });
  }
  return checks;
}

async function main() {
  const only = arg('--client');
  if (only && !CLIENTS[only]) { console.error(`Unbekannter Client: ${only} (mac | android)`); process.exit(2); }
  if (arg('--repo') && !only) { console.error('--repo nur zusammen mit --client'); process.exit(2); }

  const b = await loadBundle();
  const base = arg('--base') || 'HEAD';
  const changed = new Set([
    ...git(['diff', '--name-only', base, '--', 'public']).split('\n'),
    ...git(['ls-files', '--others', '--exclude-standard', '--', 'public']).split('\n'),
  ].filter(Boolean).map((f) => f.replace(/^public\//, '')));
  const changedBundle = b.bundleFiles.filter((f) => changed.has(f));
  console.log(`Bundle-Dateien geändert gegen ${base}: ${changedBundle.length ? changedBundle.join(', ') : '—'}`);

  let failed = false;
  for (const [id, client] of Object.entries(CLIENTS)) {
    if (only && only !== id) continue;
    const repo = checkout(id, client);
    const commit = git(['log', '-1', '--format=%h %cs %s'], repo).trim();
    const checks = checkClient(clientSources(repo, client), b);
    const missing = checks.filter((c) => !c.ok);
    const touched = checks.filter((c) => c.ok && c.files.some((f) => changed.has(f)));

    console.log(`\n━━ ${client.label}: ${client.repo} @ ${commit}`);
    console.log(`Kontaktstellen: ${checks.length}`);
    if (has('--verbose')) {
      for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.kind.padEnd(22)} ${c.name.padEnd(36)} ${c.at}`);
    }
    if (touched.length) {
      console.log(`BERÜHRT — existiert noch, Datei geändert; Semantik gegen den Client-Code lesen (${touched.length}):`);
      for (const c of touched) {
        console.log(`  ${c.kind.padEnd(22)} ${c.name.padEnd(36)} ${c.at}  ↔  ${c.files.filter((f) => changed.has(f)).join(', ')}`);
      }
    }
    if (missing.length) {
      failed = true;
      console.log(`FEHLT — Breaking Change für ${client.label} (${missing.length}):`);
      for (const c of missing) console.log(`  ${c.kind.padEnd(22)} ${c.name.padEnd(36)} ${c.at}`);
    } else {
      console.log('Keine fehlende Kontaktstelle.');
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
