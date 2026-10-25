// Tripwire fuer drei strukturelle Duplikat-Hartregeln aus CLAUDE.md, die sonst
// nur als Prosa existieren und unter Kontextdruck driften:
//   1. "Ein Attribut, eine Deklaration" — kein doppeltes HTML-Attribut am selben
//      Tag (z.B. zweimal `:class`). Browser nimmt die letzte Version, die erste
//      wird stillschweigend verworfen → toter Code mit irrefuehrendem Review-Bild.
//   2. "CSS: Selektor unique pro Datei" — kein Selektor doppelt im selben File
//      und selben At-Rule-Scope. Zweite Deklaration ueberschreibt nur ihre eigenen
//      Properties, erste bleibt fuer den Rest aktiv — schwer durchschaubar.
//   3. "Memo-Pattern: ein Helper pro Modul" — kein Mix aus `_memo`/`_memoN`/N-fach
//      handrolled. Genau ein `_memo(key, deps[], fn)`-Helper pro Modul.
// Prosa-Regel = Vorschlag, Test = Gesetz. Neuer Verstoss → CI rot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');
const INDEX_HTML = join(REPO_ROOT, 'public', 'index.html');
const CSS_DIR = join(REPO_ROOT, 'public', 'css');
const JS_DIR = join(REPO_ROOT, 'public', 'js');

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, ext, out);
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const rel = (p) => relative(REPO_ROOT, p);

// ───────────────────────────────────────────────────────────
// REGEL 1: Doppeltes HTML-Attribut am selben Tag
// ───────────────────────────────────────────────────────────
// Tag-Oeffnungen extrahieren (auch mehrzeilig, Quotes als Einheit), Attribut-
// WERTE strippen (sonst greifen wir in Alpine-Objektliterale `{value:..}` rein),
// dann nur echte `name=`-Vorkommen zaehlen. Boolean-Attribute ohne `=` lassen wir
// bewusst aus (kaum Duplikat-Risiko, hohe False-Positive-Rate).
function findDuplicateAttrs(file) {
  const src = readFileSync(file, 'utf8');
  const tagRe = /<([a-zA-Z][\w-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)\/?>/g;
  const out = [];
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const tag = m[1];
    const blob = m[2].replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
    if (!blob.trim()) continue;
    const attrRe = /(^|\s)([@:.]?[A-Za-z_][\w:.\-]*)\s*=/g;
    const seen = new Map();
    let a;
    while ((a = attrRe.exec(blob)) !== null) {
      const name = a[2];
      seen.set(name, (seen.get(name) || 0) + 1);
    }
    for (const [name, count] of seen) {
      if (count > 1) {
        const line = src.slice(0, m.index).split('\n').length;
        out.push(`${rel(file)}:${line}: <${tag}> hat "${name}" ${count}x`);
      }
    }
  }
  return out;
}

test('no duplicate HTML attribute on same tag (Ein Attribut, eine Deklaration)', () => {
  const files = [...walk(PARTIALS_DIR, '.html'), INDEX_HTML];
  const violations = files.flatMap(findDuplicateAttrs);
  assert.equal(
    violations.length,
    0,
    'Doppeltes Attribut am selben Tag — letzte gewinnt, erste ist toter Code:\n  ' +
      violations.join('\n  '),
  );
});

// ───────────────────────────────────────────────────────────
// REGEL 2: CSS-Selektor doppelt in derselben Datei (gleicher At-Rule-Scope)
// ───────────────────────────────────────────────────────────
// Brace-Tiefe + At-Rule-Stack tracken; Schluessel = Scope-Praefix + normalisierter
// Selektor-Head. Gleicher Selektor in unterschiedlichem @media/@layer-Scope ist
// KEIN Verstoss (bewusste responsive/thematische Variation).
function findDuplicateSelectors(file) {
  let src = readFileSync(file, 'utf8');
  // Kommentare zu Whitespace (Zeilen erhalten), damit `/* a {} */` nicht zaehlt.
  src = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const seen = new Map(); // key -> [{ line, sel }]
  const scope = [];
  let buf = '';
  let curLine = 1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\n') curLine++;
    if (ch === '{') {
      const head = buf.trim();
      buf = '';
      if (head.startsWith('@')) {
        scope.push('@' + head.replace(/\s+/g, ' '));
      } else {
        const norm = head.replace(/\s+/g, ' ').trim();
        if (norm) {
          const key = scope.join('||') + '###' + norm;
          if (!seen.has(key)) seen.set(key, []);
          seen.get(key).push({ line: curLine, sel: norm });
        }
        scope.push('§decl§');
      }
    } else if (ch === '}') {
      scope.pop();
      buf = '';
    } else {
      buf += ch;
    }
  }
  const out = [];
  for (const arr of seen.values()) {
    if (arr.length > 1) {
      out.push(`${rel(file)}: "${arr[0].sel}" ${arr.length}x (Zeilen ${arr.map((x) => x.line).join(', ')})`);
    }
  }
  return out;
}

test('no duplicate CSS selector within same file+scope (Selektor unique pro Datei)', () => {
  const violations = walk(CSS_DIR, '.css').flatMap(findDuplicateSelectors);
  assert.equal(
    violations.length,
    0,
    'Selektor doppelt im selben File+Scope — bewusste Variation via Variant-Klasse, nicht Re-Definition:\n  ' +
      violations.join('\n  '),
  );
});

// ───────────────────────────────────────────────────────────
// REGEL 3: Kein Mix aus _memo/_memoN (genau ein Helper pro Modul)
// ───────────────────────────────────────────────────────────
// Nummerierte Varianten (_memo2, _memo3, …) sind der Drift-Indikator: das Pattern
// schreibt genau EINEN `_memo(key, deps[], fn)`-Helper vor.
function findMemoNVariants(file) {
  const src = readFileSync(file, 'utf8');
  const hits = [...new Set([...src.matchAll(/_memo(\d+)\s*[(:=]/g)].map((x) => x[0]))];
  return hits.length ? [`${rel(file)}: ${hits.join(', ')}`] : [];
}

test('no _memoN variant in modules (Memo-Pattern: ein Helper pro Modul)', () => {
  const violations = walk(JS_DIR, '.js').flatMap(findMemoNVariants);
  assert.equal(
    violations.length,
    0,
    'Nummerierte Memo-Variante gefunden — genau ein _memo(key, deps[], fn)-Helper pro Modul:\n  ' +
      violations.join('\n  '),
  );
});

// REGEL 3b: `_memo` wird nicht pro Modul neu geschrieben — Karten spreaden
// `...memoMethods` aus cards/card-memo.js (eine Implementierung, ein Speicher
// `this._memos`). Lokale Kopien driften in Feldnamen (value/val), Speicher
// (`_memos` vs. karten-eigene Maps) und Deps-Kopie vs. -Referenz.
const MEMO_SSOT = 'public/js/cards/card-memo.js';

test('_memo nur in cards/card-memo.js definiert (Konsumenten spreaden memoMethods)', () => {
  const violations = [];
  for (const file of walk(JS_DIR, '.js')) {
    const r = rel(file);
    if (r === MEMO_SSOT) continue;
    const src = readFileSync(file, 'utf8');
    if (/^\s*_memo\s*(?:\(\s*\w+\s*,|:\s*(?:function|\()|=\s*(?:function|\())/m.test(src)) violations.push(r);
  }
  assert.deepEqual(
    violations,
    [],
    'Lokale _memo-Definition — stattdessen `...memoMethods` aus cards/card-memo.js spreaden:\n  ' +
      violations.join('\n  '),
  );
});
