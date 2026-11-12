// Gate fuer string-seitige Fragment-Includes (`<!-- @include NAME -->`,
// public/js/app/app-ui.js#_resolveIncludes, docs/architektur.md).
//
// Ein Fragment bekommt keine Parameter: es liest die x-for-Variablen der Stelle,
// an der es eingebettet wird (`beat`, `msg`, `row` …). Dieser Vertrag steht als
// Kopfzeile im Fragment — `<!-- @expects beat -->`, mehrere mit Komma — und
// wird hier gegen jede Einbettungsstelle geprueft. Ohne das bricht ein
// umbenannter Loop-Alias im Board das Fragment still (Alpine wertet `beat` als
// undefined aus, kein Fehler im Template-Test).
//
// Geprueft wird:
//   1. Jeder Marker zeigt auf ein existierendes Partial.
//   2. Kein Marker auf ein ANDERES Fragment steckt in einem Doku-Kommentar —
//      der Resolver expandierte ihn dort, und das erste `-->` des eingesetzten
//      Markups beendete den Kommentar (Doku-Text leckt sichtbar ins UI). Den
//      eigenen Namen im Kopfkommentar zu nennen ist unschaedlich: `seen` loest
//      die Selbstreferenz zu '' auf, der Kommentar bleibt ganz.
//   3. Jeder `@expects`-Name ist an JEDER Einbettungsstelle gebunden: durch ein
//      umschliessendes x-for dort oder durch das `@expects` des einbettenden
//      Fragments (transitiv, z.B. plot-beat-edit in plot-beat-cell).
//   4. Vollstaendigkeit: liest ein Fragment eine Variable, die an einer seiner
//      Einbettungsstellen x-for-gebunden ist, steht sie in seinem `@expects`.
//   5. Kein `@expects` ohne Gebrauch (toter Vertrag).
//
// Bewusste Naeherung: Scope wird per Tag-Stack aus dem Quelltext gelesen (kein
// DOM), Ausdruecke per Bezeichner-Regex nach Abzug von '…'-Literalen und
// Objekt-Schluesseln. x-data-Locals der Einbettungsstelle sind nicht Teil des
// Vertrags — nur Loop-Aliase.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PARTIALS_DIR = join(REPO_ROOT, 'public', 'partials');

const EXPECTS_RE = /<!--\s*@expects\s+([\w$,\s]+?)\s*-->/g;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'source', 'track', 'wbr']);

const src = Object.fromEntries(readdirSync(PARTIALS_DIR)
  .filter(f => f.endsWith('.html'))
  .map(f => [f.slice(0, -5), readFileSync(join(PARTIALS_DIR, f), 'utf8')]));

const expectsOf = Object.fromEntries(Object.entries(src).map(([name, s]) => [
  name,
  new Set([...s.matchAll(EXPECTS_RE)].flatMap(m => m[1].split(',').map(x => x.trim()).filter(Boolean))),
]));

// Kommentare raus, Include-Marker bleiben (sie sind die Einbettungsstellen).
const stripComments = s => s.replace(/<!--(?!\s*@include\s+[\w-]+\s*-->)[\s\S]*?-->/g, '');

function xforAliases(expr) {
  const m = expr.match(/^\s*([\s\S]+?)\s+(?:in|of)\s/);
  if (!m) return { aliases: [], rhs: expr };
  return {
    aliases: m[1].replace(/[()[\]{}]/g, ' ').split(/[\s,]+/).filter(Boolean),
    rhs: expr.slice(m[0].length),
  };
}

// Laeuft den Tag-Baum ab. onTag(attrs, scope) je oeffnendem Tag (scope = Aliase
// der Vorfahren), onMarker(name, scope) je Include-Marker.
function walk(html, { onTag, onMarker }) {
  const stack = [];
  const re = /<!--\s*@include\s+([\w-]+)\s*-->|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const scope = stack.flatMap(e => e.aliases);
    if (m[1]) { onMarker?.(m[1], scope); continue; }
    const [, , close, rawTag, attrs] = m;
    const tag = rawTag.toLowerCase();
    if (close) {
      const i = stack.map(e => e.tag).lastIndexOf(tag);
      if (i >= 0) stack.length = i;
      continue;
    }
    const xf = attrs.match(/\sx-for="([^"]*)"/);
    const own = xf ? xforAliases(xf[1]).aliases : [];
    onTag?.(attrs, scope, own);
    if (VOID.has(tag) || /\/\s*$/.test(attrs)) continue;
    stack.push({ tag, aliases: own });
  }
}

const escRe = s => s.replace(/[$]/g, '\\$');
// Liest `expr` den Bezeichner `name`? '…'-Literale und Objekt-Schluessel
// (`{ name: …`, `, name: …`) zaehlen nicht, Property-Zugriffe (`.name`) auch nicht.
function usesIdent(expr, name) {
  const n = escRe(name);
  const code = expr
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(new RegExp(`([{,]\\s*)${n}(\\s*:)(?!:)`, 'g'), '$1_$2');
  return new RegExp(`(?<![\\w$.])${n}(?![\\w$])`).test(code);
}

// Freie Lesezugriffe eines Fragments: Bezeichner in Alpine-Attributen, die nicht
// vom eigenen x-for an dieser Stelle gebunden sind.
function freeUses(html, candidates) {
  const used = new Set();
  walk(html, {
    onTag(attrs, scope, own) {
      for (const a of attrs.matchAll(/\s(x-[\w:.-]+|:[\w.-]+|@[\w.:-]+)="([^"]*)"/g)) {
        const [, attr, expr] = a;
        const local = attr === 'x-for' ? scope : [...scope, ...own];
        const checked = attr === 'x-for' ? xforAliases(expr).rhs : expr;
        for (const c of candidates) if (!local.includes(c) && usesIdent(checked, c)) used.add(c);
      }
    },
  });
  return used;
}

// Einbettungsstellen: frag → [{ from, bound }], bound = Aliase dort ∪ @expects des Einbetters.
const sites = {};
for (const [name, s] of Object.entries(src)) {
  walk(stripComments(s), {
    onMarker(frag, scope) {
      (sites[frag] ||= []).push({ from: name, bound: new Set([...scope, ...expectsOf[name]]) });
    },
  });
}

test('jeder @include-Marker zeigt auf ein existierendes Partial', () => {
  const missing = Object.entries(sites)
    .filter(([frag]) => !(frag in src))
    .map(([frag, ss]) => `${frag} (aus ${[...new Set(ss.map(x => x.from))].join(', ')})`);
  assert.deepEqual(missing, [], `Fragment-Datei fehlt:\n  ${missing.join('\n  ')}`);
});

test('kein Marker auf ein fremdes Fragment innerhalb eines Doku-Kommentars', () => {
  const bad = [];
  for (const [name, s] of Object.entries(src)) {
    // Ein Marker in einem Doku-Kommentar macht daraus `<!-- Doku … <!-- @include x -->`:
    // der erste Kommentar endet am Marker-Delimiter und enthaelt ein zweites `<!--`.
    for (const c of s.matchAll(/<!--[\s\S]*?-->/g)) {
      const inner = c[0].slice(4).match(/<!--\s*@include\s+([\w-]+)\s*-->/);
      if (inner && inner[1] !== name) {
        bad.push(`${name}.html: Marker auf «${inner[1]}» im Kommentar «${c[0].slice(0, 60).replace(/\s+/g, ' ')}…»`);
      }
    }
  }
  assert.deepEqual(bad, [], `Marker in Kommentar — Delimiter nicht ausschreiben:\n  ${bad.join('\n  ')}`);
});

test('@expects ist an jeder Einbettungsstelle gebunden', () => {
  const bad = [];
  for (const [frag, need] of Object.entries(expectsOf)) {
    if (!need.size) continue;
    if (!sites[frag]) { bad.push(`${frag}: @expects, aber nirgends eingebettet`); continue; }
    for (const site of sites[frag]) {
      const missing = [...need].filter(n => !site.bound.has(n));
      if (missing.length) bad.push(`${frag} in ${site.from}.html: ${missing.join(', ')} dort nicht gebunden`);
    }
  }
  assert.deepEqual(bad, [], `Scope-Vertrag verletzt:\n  ${bad.join('\n  ')}`);
});

test('Fragmente deklarieren jede gelesene Loop-Variable ihrer Einbettungsstelle', () => {
  const bad = [];
  for (const [frag, ss] of Object.entries(sites)) {
    if (!(frag in src)) continue;
    const candidates = new Set(ss.flatMap(x => [...x.bound]));
    const used = freeUses(stripComments(src[frag]), candidates);
    const undeclared = [...used].filter(n => !expectsOf[frag].has(n));
    if (undeclared.length) bad.push(`${frag}.html: <!-- @expects ${undeclared.join(', ')} --> fehlt`);
  }
  assert.deepEqual(bad, [], `Fragment liest Variablen der Einbettungsstelle ohne Vertrag:\n  ${bad.join('\n  ')}`);
});

test('kein @expects ohne Gebrauch', () => {
  const bad = [];
  for (const [frag, need] of Object.entries(expectsOf)) {
    if (!need.size) continue;
    const used = freeUses(stripComments(src[frag]), need);
    const dead = [...need].filter(n => !used.has(n));
    if (dead.length) bad.push(`${frag}.html: ${dead.join(', ')} deklariert, aber nicht gelesen`);
  }
  assert.deepEqual(bad, [], `Toter Vertrag:\n  ${bad.join('\n  ')}`);
});
