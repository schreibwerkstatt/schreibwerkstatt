// Gate fuer Reiter-Wuensche (public/js/cards/card-request.js, cards/CLAUDE.md
// „card:request"): ein Wunsch, der sichtbaren Karten-Zustand umschaltet
// (Reiter, Modus), heisst `*_TAB` und wird ausschliesslich ueber
// `tabRequest: { key, apply }` in setupCardLifecycle abgeholt. Der Lifecycle
// holt ihn synchron beim Einblenden; eine Karte, die nur auf das CARD_REQUEST-
// Event hoert, zeigt einen Frame lang den gemerkten Reiter (das Event kommt
// erst nach dem Oeffnen). Das Verhalten selbst prueft
// tests/e2e-app/card-tab-request.spec.js.
//
// Geprueft wird:
//   1. Jeder `*_TAB`-Schluessel hat genau eine `tabRequest`-Anmeldung.
//   2. Kein `*_TAB`-Schluessel wird von Hand abgeholt oder verglichen
//      (`takeCardRequest(CARD_REQUEST.X_TAB)`, `=== CARD_REQUEST.X_TAB`).
//   3. `tabRequest` nimmt nur `*_TAB`-Schluessel.
//   4. Jeder uebrige Schluessel hat einen Abnehmer per `takeCardRequest`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const JS_DIR = join(REPO_ROOT, 'public', 'js');
const REQUEST_FILE = join(JS_DIR, 'cards', 'card-request.js');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const rel = (p) => relative(REPO_ROOT, p);

function requestKeys() {
  const src = readFileSync(REQUEST_FILE, 'utf8');
  const block = src.match(/CARD_REQUEST\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\)/);
  assert.ok(block, 'CARD_REQUEST-Block in card-request.js nicht gefunden');
  return [...block[1].matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)].map(m => m[1]);
}

const files = walk(JS_DIR).map(f => ({ path: rel(f), src: readFileSync(f, 'utf8') }));
const keys = requestKeys();
const tabKeys = keys.filter(k => k.endsWith('_TAB'));

function hits(re) {
  const out = [];
  for (const { path, src } of files) {
    for (const m of src.matchAll(re)) out.push({ path, match: m[0], key: m[1] });
  }
  return out;
}

test('CARD_REQUEST hat Reiter-Schluessel (Parser greift)', () => {
  assert.ok(tabKeys.length >= 3, `erwartet mind. 3 *_TAB-Schluessel, gefunden: ${tabKeys.join(', ')}`);
});

test('jeder *_TAB-Wunsch hat genau eine tabRequest-Anmeldung', () => {
  const regs = hits(/tabRequest:\s*\{\s*key:\s*CARD_REQUEST\.([A-Z0-9_]+)/g);
  const bad = [];
  for (const k of tabKeys) {
    const n = regs.filter(r => r.key === k);
    if (n.length !== 1) bad.push(`${k}: ${n.length}x (${n.map(r => r.path).join(', ') || '—'})`);
  }
  assert.deepEqual(bad, [], 'Reiter-Wunsch braucht genau eine `tabRequest`-Anmeldung in setupCardLifecycle:\n  ' + bad.join('\n  '));
});

test('tabRequest nimmt nur *_TAB-Schluessel', () => {
  const regs = hits(/tabRequest:\s*\{\s*key:\s*CARD_REQUEST\.([A-Z0-9_]+)/g);
  const bad = regs.filter(r => !r.key.endsWith('_TAB')).map(r => `${r.path}: ${r.key}`);
  assert.deepEqual(bad, [], 'tabRequest ist fuer Reiter-Wuensche (*_TAB); Session/Entwurf/Abschnitt greifen erst nach dem Laden:\n  ' + bad.join('\n  '));
});

test('kein *_TAB-Wunsch wird von Hand abgeholt oder verglichen', () => {
  const bad = [
    ...hits(/takeCardRequest\(\s*CARD_REQUEST\.([A-Z0-9_]+_TAB)\b/g),
    ...hits(/===?\s*CARD_REQUEST\.([A-Z0-9_]+_TAB)\b/g),
  ].map(h => `${h.path}: ${h.match}`);
  assert.deepEqual(bad, [], 'Reiter-Wunsch nur ueber `tabRequest` in setupCardLifecycle abholen — sonst greift er erst nach dem Einblenden:\n  ' + bad.join('\n  '));
});

test('jeder uebrige Wunsch hat einen Abnehmer', () => {
  const taken = new Set(hits(/takeCardRequest\(\s*CARD_REQUEST\.([A-Z0-9_]+)/g).map(h => h.key));
  const bad = keys.filter(k => !k.endsWith('_TAB') && !taken.has(k));
  assert.deepEqual(bad, [], 'CARD_REQUEST-Schluessel ohne Abnehmer (takeCardRequest):\n  ' + bad.join('\n  '));
});
