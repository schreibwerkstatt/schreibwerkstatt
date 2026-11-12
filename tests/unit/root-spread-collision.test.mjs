// Gate: kein Key doppelt im Root-Objekt `Alpine.data('lektorat')`.
//
// app.js baut den Root aus initialLektoratState() (16+ Slices), ~40
// gespreadeten Methoden-Modulen, eigenen Gettern und danach
// `Object.defineProperties(obj, rootGetterDescriptors)`. Bei gleichem Namen
// gewinnt still der spätere Eintrag: eine Methode überschreibt ein State-Feld,
// ein Descriptor eine Methode — ohne Fehler, ohne Warnung, und welcher Pfad
// lebt, hängt an der Spread-Reihenfolge in app.js (docs/state-modell.md,
// „Root-State-Slices").
//
// Statisch über den TypeScript-AST (die Module selbst lassen sich in Node nicht
// importieren — sie greifen beim Laden auf Browser-Globals zu). Erfasst werden
// Objekt-Literale, deren Spreads (auch über Facade-Re-Exports) und die von
// `makeHeartbeatTracker` erzeugten Methoden- und Laufzeit-Felder.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const APP = join(ROOT, 'public', 'js', 'app.js');
const STATE = join(ROOT, 'public', 'js', 'app', 'app-state.js');
const GETTERS = join(ROOT, 'public', 'js', 'app', 'app-root-getters.js');

const sfCache = new Map();
function sourceFile(file) {
  if (!sfCache.has(file)) {
    sfCache.set(file, ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true));
  }
  return sfCache.get(file);
}

function resolveSpec(from, spec) {
  if (!spec.startsWith('.')) return null;
  const p = resolve(dirname(from), spec);
  if (existsSync(p) && statSync(p).isFile()) return p;
  if (existsSync(p + '.js')) return p + '.js';
  return null;
}

function importMap(sf) {
  const m = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue;
    const nb = st.importClause?.namedBindings;
    if (!nb || !ts.isNamedImports(nb)) continue;
    for (const el of nb.elements) {
      m.set(el.name.text, { spec: st.moduleSpecifier.text, name: (el.propertyName || el.name).text });
    }
  }
  return m;
}

function findDeclInit(sf, name) {
  let found = null;
  const visit = (n) => {
    if (found) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) found = n.initializer;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

const unresolved = [];

/** Keys, die der Ausdruck `expr` (in `file`) zum Root-Objekt beiträgt. */
function keysOfExpr(file, expr, depth) {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (ts.isIdentifier(expr)) return keysOfName(file, expr.text, depth + 1);
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression.getText();
    if (callee === 'makeHeartbeatTracker') return heartbeatKeys(expr);
    // Slice-Aufruf `fooState()`: Rückgabe der Arrow-Funktion auswerten.
    if (ts.isIdentifier(expr.expression)) return keysOfName(file, expr.expression.text, depth + 1, { call: true });
  }
  if (ts.isObjectLiteralExpression(expr)) return keysOfObject(file, expr, depth);
  unresolved.push(`${relative(ROOT, file)}: ${expr.getText().slice(0, 60)}`);
  return [];
}

function keysOfObject(file, obj, depth) {
  const out = [];
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) out.push(...keysOfExpr(file, p.expression, depth));
    else if (p.name) out.push(p.name.getText().replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

function returnedObject(fn) {
  let body = fn.body;
  while (body && ts.isParenthesizedExpression(body)) body = body.expression;
  if (body && ts.isObjectLiteralExpression(body)) return body;
  if (body && ts.isBlock(body)) {
    const ret = body.statements.find(ts.isReturnStatement);
    let e = ret?.expression;
    while (e && ts.isParenthesizedExpression(e)) e = e.expression;
    if (e && ts.isObjectLiteralExpression(e)) return e;
  }
  return null;
}

function keysOfName(file, name, depth, { call = false } = {}) {
  assert.ok(depth < 12, `Spread-Kette zu tief bei ${name} (${relative(ROOT, file)})`);
  const sf = sourceFile(file);
  let init = findDeclInit(sf, name);
  if (!init) {
    const fnDecl = sf.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
    if (fnDecl && call) {
      const obj = returnedObject(fnDecl);
      if (obj) return keysOfObject(file, obj, depth);
    }
    for (const st of sf.statements) {
      if (!ts.isExportDeclaration(st) || !st.moduleSpecifier || !st.exportClause) continue;
      for (const el of st.exportClause.elements) {
        if (el.name.text !== name) continue;
        const target = resolveSpec(file, st.moduleSpecifier.text);
        if (target) return keysOfName(target, (el.propertyName || el.name).text, depth + 1, { call });
      }
    }
    const imp = importMap(sf).get(name);
    if (imp) {
      const target = resolveSpec(file, imp.spec);
      if (target) return keysOfName(target, imp.name, depth + 1, { call });
    }
    unresolved.push(`${relative(ROOT, file)}: ${name}`);
    return [];
  }
  if (call && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
    const obj = returnedObject(init);
    if (obj) return keysOfObject(file, obj, depth);
    unresolved.push(`${relative(ROOT, file)}: ${name}() ohne Objekt-Rückgabe`);
    return [];
  }
  return keysOfExpr(file, init, depth);
}

// makeHeartbeatTracker({ name, methods: { start: '_x', … } }): die Methoden heissen
// wie die String-Werte in `methods`; dazu legt der Tracker zur Laufzeit
// `_<name>ActiveSince` und `_<name>HeartbeatTimer` am Root an.
function heartbeatKeys(call) {
  const arg = call.arguments[0];
  const out = [];
  let name = null;
  for (const p of arg.properties) {
    if (!p.name) continue;
    const key = p.name.getText();
    if (key === 'name' && ts.isStringLiteral(p.initializer)) name = p.initializer.text;
    if (key === 'methods' && ts.isObjectLiteralExpression(p.initializer)) {
      for (const m of p.initializer.properties) {
        if (m.initializer && ts.isStringLiteral(m.initializer)) out.push(m.initializer.text);
      }
    }
  }
  if (name) out.push(`_${name}ActiveSince`, `_${name}HeartbeatTimer`);
  return out;
}

/** Root-Objekt-Literal in app.js (das mit `...initialLektoratState()`). */
function rootObjectLiteral() {
  const sf = sourceFile(APP);
  let found = null;
  const visit = (n) => {
    if (found) return;
    if (ts.isObjectLiteralExpression(n)
        && n.properties.some(p => ts.isSpreadAssignment(p) && p.expression.getText() === 'initialLektoratState()')) {
      found = n;
    } else ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** [{ key, source }] in Aufbau-Reihenfolge des Roots. */
function collectRootKeys() {
  const entries = [];
  const obj = rootObjectLiteral();
  assert.ok(obj, 'Root-Objekt mit ...initialLektoratState() in app.js nicht gefunden');
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      const label = p.expression.getText();
      if (label === 'initialLektoratState()') {
        const fn = sourceFile(STATE).statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'initialLektoratState');
        const ret = returnedObject(fn);
        for (const sp of ret.properties) {
          const slice = sp.expression.getText();
          for (const key of keysOfExpr(STATE, sp.expression, 0)) entries.push({ key, source: `app-state ${slice}` });
        }
      } else {
        for (const key of keysOfExpr(APP, p.expression, 0)) entries.push({ key, source: label });
      }
    } else if (p.name) {
      entries.push({ key: p.name.getText(), source: 'app.js (eigener Eintrag)' });
    }
  }
  for (const key of keysOfName(GETTERS, 'rootGetterDescriptors', 0)) {
    entries.push({ key, source: 'rootGetterDescriptors' });
  }
  return entries;
}

test('Root-Objekt: kein Key aus zwei Quellen (State, Methoden-Module, Getter)', () => {
  const entries = collectRootKeys();
  assert.ok(entries.length > 500, `zu wenige Root-Keys erkannt (${entries.length}) — Parser kaputt?`);
  const owner = new Map();
  const dups = [];
  for (const { key, source } of entries) {
    const prev = owner.get(key);
    if (prev && prev !== source) dups.push(`${key}: ${prev} ↔ ${source}`);
    else if (!prev) owner.set(key, source);
  }
  assert.deepEqual(dups, [], `Doppelte Root-Keys (der spätere Eintrag überschreibt still):\n  ${dups.join('\n  ')}`);
});

test('Root-Objekt: jeder Spread statisch auflösbar', () => {
  unresolved.length = 0;
  collectRootKeys();
  assert.deepEqual(
    unresolved, [],
    'Nicht auflösbare Spreads — Gate sähe Kollisionen dort nicht. Spread auf ein '
    + 'Objekt-Literal/Identifier umstellen oder den Parser erweitern:\n  ' + unresolved.join('\n  '),
  );
});
