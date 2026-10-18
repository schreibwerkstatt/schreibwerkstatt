'use strict';
// Kontaktstellen zwischen dem OTA-Editor-Bundle und den nativen Clients — die
// Analyse hinter scripts/check-clients-compat.js (CLI) und
// tests/unit/editor-surface.test.js (deklarierte Fläche, contract/editor-surface.json).
//
// Zwei getrennte Fragen, damit die zweite ohne Client-Repos beantwortbar ist:
//   contactPoints(sources, b) — was benutzt ein Client? (liest dessen Quelltext)
//   provides(kind, name, b)   — stellt das Bundle das noch bereit? (liest nur public/)

const fs = require('node:fs');
const path = require('node:path');
const { buildClosure, ENTRY_MODULES, CSS_FILES } = require('../lib/editor-bundle');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');

// Markup, das ein Client selbst anlegt (Android-Toolbar: Checkliste). Nicht im
// Bundle, aber an den SSoT gebunden, den Notebook, Export und Server lesen.
const MARKUP_SSOT = ['js/editor/shared/todo-html.js'];

// Native Member, die zufällig `controller.`/`host.` heissen.
const NATIVE_NOISE = new Set(['addUserScript', 'addScriptMessageHandler', 'removeAllUserScripts',
  'removeScriptMessageHandler', 'removeAllScriptMessageHandlers', 'js', 'hasPrefix', 'isEmpty']);

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

// Arten von Kontaktstellen. `id` ist der Schlüssel in contract/editor-surface.json,
// `label` die Spalte der CLI-Ausgabe.
const KINDS = [
  { id: 'modules', label: 'Modul' },
  { id: 'exports', label: 'Export' },
  { id: 'options', label: 'Option/Bridge-Feld' },
  { id: 'members', label: 'Handle/Host/Controller' },
  { id: 'classes', label: 'Klasse' },
  { id: 'cssVars', label: 'CSS-Variable' },
  { id: 'highlights', label: 'Highlight' },
  { id: 'manifest', label: 'Manifest-Feld' },
];
const LABEL = Object.fromEntries(KINDS.map((k) => [k.id, k.label]));

/** Was ein Client benutzt: [{ kind, name, at }] (kind = KINDS[].id). */
function contactPoints(sources) {
  const out = [];
  const add = (kind, map) => { for (const [name, at] of map) out.push({ kind, name, at }); };

  // 1. Module, die der Client per Pfad lädt.
  add('modules', collect(sources, /(?:import\(\s*|new URL\(\s*)['"](?:\.\/)?(js\/[^'"]+\.js)['"]/g, (m) => m[1]));

  // 2. Exporte, die er daraus benutzt (Destrukturierung, `<x>Mod.fn`/`mod.fn`
  //    und `<ns>.fn` auf einem per `await import()` gebundenen Namespace).
  const exports = new Map([
    ...namespaceMembers(sources),
    ...collect(sources, /\{([^}]+)\}\s*=\s*await\s+import\(/g,
      (m) => m[1].split(',').map((x) => x.trim().split(/\s*:\s*/)[0])),
    ...collect(sources, /\b(?:mod|[a-z]\w*Mod)\.([A-Za-z_]\w*)/g, (m) => m[1]),
  ]);
  add('exports', exports);

  // 3. Optionen an Editor-Funktionen + Felder des eigenen Bridge-Objekts.
  const fnNames = [...exports.keys()].filter((n) => /^(mount|create)/.test(n));
  add('options', objectKeys(sources, fnNames));

  // 4. Handle-, Host- und Controller-Felder — auch Ketten wie
  //    `handle.controller._focusUpdateActive` und per defineProperty ersetzte
  //    Host-Felder (Android: Getter für `typewriterAnchor`).
  add('members', new Map([
    ...collect(sources, /(?<=(?<![\w/-])(?:__standalone|__swHandle|handle|host|controller)\??\.)([A-Za-z_]\w*)(?![\w-]*\.(?:html|css|js|json))/g,
      (m) => (NATIVE_NOISE.has(m[1]) || /^(html|css|js|json)$/.test(m[1]) ? null : m[1])),
    ...collect(sources, /defineProperty\(\s*host\s*,\s*['"](\w+)['"]/g, (m) => m[1]),
  ]));

  // 5. Klassen, die Host-CSS/Glue selektieren, setzen oder als Markup anlegen.
  add('classes', collect(sources,
    /(?<![\w-])((?:focus-(?:editor|mode|cursor|paragraph)|lt-|synonym-|figur-lookup|todo)[a-z0-9_-]*|is-active)(?![\w])/g,
    (m) => m[1]));

  // 6. CSS-Variablen des Editors (die eigenen `--sw-*` der Clients nicht).
  add('cssVars', collect(sources, /(--(?:focus|color|opacity)-[a-z0-9-]+)/g, (m) => m[1]));

  // 7. Highlight-Namen (CSS Custom Highlight API).
  add('highlights', collect(sources, /::highlight\(([\w-]+)\)/g, (m) => m[1]));

  // 8. Manifest-Felder (macOS liest sie nativ, Android in host.html).
  add('manifest', collect(sources, /\bmanifest\??\.([A-Za-z_]\w*)(?!\s*\()/g, (m) => (m[1] === 'json' ? null : m[1]), 'code'));
  return out;
}

/** Stellt das Bundle die Kontaktstelle noch bereit? Liest nur public/ + lib/editor-bundle.js. */
function provides(kind, name, b) {
  switch (kind) {
    case 'modules': return b.jsFiles.includes(name);
    case 'exports': return b.exportedIn(name).length > 0;
    case 'options': {
      // Optionen: Name muss im definierenden Modul (bzw. seinem Ordner) vorkommen.
      // Bridge: was der Client mitgibt, muss der Editor noch lesen (`bridge.x`).
      const [fn, key] = name.split('.');
      if (fn === 'bridge') return new RegExp(`\\bbridge\\.${key}\\b`).test(b.jsText);
      const dirs = b.exportedIn(fn).map((f) => path.posix.dirname(f));
      return b.jsFiles.some((f) => dirs.includes(path.posix.dirname(f)) && new RegExp(`\\b${key}\\b`).test(b.text.get(f)));
    }
    case 'members': return new RegExp(`\\b${name}\\b`).test(b.jsText);
    case 'classes': {
      if (b.filesWith(name, MARKUP_SSOT).length > 0) return true;
      // Modifier wie `focus-mode--sentence` setzt der Editor zusammen
      // (`'focus-mode--' + g`): Präfix im Bundle + Wert als String-Literal reicht.
      const i = name.indexOf('--');
      if (i < 1 || i + 2 >= name.length) return false;
      return b.filesWith(name.slice(0, i + 2)).length > 0 && new RegExp(`['"\`]${name.slice(i + 2)}['"\`]`).test(b.jsText);
    }
    case 'cssVars':
    case 'highlights': return b.filesWith(name).length > 0;
    case 'manifest': return new RegExp(`\\bmanifest\\s*=\\s*\\{[^}]*\\b${name}\\b`).test(b.bundleSrc);
    default: throw new Error(`Unbekannte Kontaktstellen-Art: ${kind}`);
  }
}

/** Dateien des Bundles, an denen die Kontaktstelle hängt (für die „berührt"-Liste). */
function filesFor(kind, name, b) {
  switch (kind) {
    case 'modules': return [name];
    case 'exports': return b.exportedIn(name);
    case 'options': {
      const [fn] = name.split('.');
      return fn === 'bridge' ? ['js/editor/focus/standalone.js'] : b.exportedIn(fn);
    }
    case 'classes': return b.filesWith(name, MARKUP_SSOT);
    case 'manifest': return ['lib/editor-bundle.js'];
    default: return b.filesWith(name);
  }
}

/** Was der Editor vom Bridge-Objekt der Schale VERLANGT (`typeof bridge.x !== 'function'`). */
function requiredBridge(b) {
  return [...b.standalone.matchAll(/typeof bridge\.(\w+) !== 'function'/g)].map((m) => m[1]);
}

function checkClient(sources, b) {
  const checks = contactPoints(sources).map((c) => ({
    ...c, label: LABEL[c.kind], ok: provides(c.kind, c.name, b), files: filesFor(c.kind, c.name, b),
  }));
  // Gegenrichtung: jede Pflicht-Funktion der Bridge muss die Schale anbieten.
  const webAll = sources.map((x) => x.web.map((l) => l.text).join('\n')).join('\n');
  for (const name of requiredBridge(b)) {
    checks.push({ kind: 'bridgeRequired', label: 'Bridge (Pflicht)', name, at: 'js/editor/focus/standalone.js',
      ok: new RegExp(`\\b${name}\\s*(?::|\\()`).test(webAll), files: [] });
  }
  return checks;
}

module.exports = { KINDS, clientSources, loadBundle, contactPoints, provides, filesFor, requiredBridge, checkClient };
