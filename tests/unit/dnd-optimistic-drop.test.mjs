// Gate: jeder SortableJS-Drop ist optimistisch (DESIGN.md „Board-Drag",
// public/js/sortable-dnd.js#revertSortable).
//
// Nach `revertSortable(evt)` steht die Karte wieder in ihrer Quelle; erst das
// Modell rendert sie ans Ziel. Wartet der Handler vorher auf den Server, zeigt
// das Board die Karte bis zur Antwort in der Quelle — sie flackert zurueck und
// springt dann. Darum gilt fuer jedes `await` nach `revertSortable`: davor ist
// das Modell schon geaendert, ODER das erwartete `this.<methode>(…)` aendert es
// selbst vor seinem ersten `await` (rekursiv geprueft).
//
// Statische Pruefung: eine Methode reicht vom Kopf bis zum naechsten
// Methodenkopf der Datei. Sie faengt den typischen Fehler (`revertSortable`,
// dann `await patch…`, dann Modell aus der Antwort) — nicht jede denkbare Form.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const JS_DIR = join(REPO_ROOT, 'public', 'js');
const CORE = 'public/js/sortable-dnd.js';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}
const rel = (p) => relative(REPO_ROOT, p);
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Methodenkopf in einem Objekt-Literal (Methods-Module der Karten).
const METHOD_HEAD = /^\s{2}(?:async\s+)?([_a-zA-Z]\w*)\s*\([^)]*\)\s*\{/gm;

// Modell-Aenderung: Zuweisung an einen Karten-Zustand (ausser Flags/Memo),
// ein splice oder ein abgeschlossener _replace*-Aufruf. Feld-Zuweisungen
// (`x.y = …`) zaehlen nicht — die treffen auch lokale Request-Bodies.
const NOT_MODEL = new Set(['busy', 'errorMessage', '_memos', '_dragBeatId', 'organizerSaving']);
function mutates(seg) {
  for (const m of seg.matchAll(/this\.(\w+)\s*=(?!=)/g)) if (!NOT_MODEL.has(m[1])) return true;
  if (/\.splice\(/.test(seg)) return true;
  // abgeschlossener Aufruf — `this._replaceX(await …)` zaehlt nicht
  if (/this\._replace\w*\((?:[^()]|\([^()]*\))*\)/.test(seg)) return true;
  return false;
}

const files = walk(JS_DIR).filter(f => rel(f) !== CORE).map(f => ({ path: rel(f), src: stripComments(readFileSync(f, 'utf8')) }));

// name → Liste der Methoden-Rümpfe (Kopf bis naechster Kopf).
const methods = new Map();
const handlers = [];
for (const { path, src } of files) {
  const heads = [...src.matchAll(METHOD_HEAD)];
  heads.forEach((h, i) => {
    const body = src.slice(h.index + h[0].length, i + 1 < heads.length ? heads[i + 1].index : src.length);
    if (!methods.has(h[1])) methods.set(h[1], []);
    methods.get(h[1]).push(body);
    if (/\brevertSortable\(/.test(body)) handlers.push({ path, name: h[1], body });
  });
}

function optimistic(name, seen = new Set()) {
  if (seen.has(name)) return false;
  seen.add(name);
  const bodies = methods.get(name);
  if (!bodies?.length) return false;
  return bodies.every((body) => {
    const i = body.search(/\bawait\b/);
    const head = i < 0 ? body : body.slice(0, i);
    if (mutates(head)) return true;
    if (i < 0) return false;
    const call = body.slice(i).match(/^await\s+this\.(\w+)\(/);
    return !!call && optimistic(call[1], seen);
  });
}

test('es gibt Drop-Handler mit revertSortable (Gate greift)', () => {
  assert.ok(handlers.length >= 5, `nur ${handlers.length} Handler gefunden — Methodenkopf-Erkennung kaputt?`);
});

test('jeder Drop setzt das Modell vor dem ersten await (optimistisch)', () => {
  const bad = [];
  for (const { path, name, body } of handlers) {
    const after = body.slice(body.search(/\brevertSortable\(/));
    let pos = 0;
    for (const m of after.matchAll(/\bawait\s+(?:this\.(\w+)\()?/g)) {
      const before = after.slice(0, m.index);
      pos = m.index;
      if (mutates(before)) break; // ab hier steht das Modell schon am Ziel
      if (m[1] && optimistic(m[1])) break;
      bad.push(`${path}#${name}: \`${after.slice(pos, pos + 60).split('\n')[0]}\` wartet, bevor das Modell am Ziel steht`);
      break;
    }
  }
  assert.deepEqual(bad, [], 'Drop wartet auf den Server, bevor das Modell geaendert ist — die Karte flackert in die Quelle zurueck. Modell vor dem await setzen, bei Fehler zuruecknehmen (DESIGN.md „Board-Drag"):\n' + bad.join('\n'));
});
