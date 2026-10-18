'use strict';
// Client-Vertrag (contract/README.md): die eingecheckten Artefakte, die die
// Client-Repos lesen, sind frisch und in sich stimmig. Die Antworten selbst
// prüft tests/integration/client-contract.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const { render, OUT } = require('../../scripts/contract-build');
const version = require('../../contract/version.json');
const { parseEditorApiHeader, editorApiCompatible, clientContract } = require('../../lib/client-contract');

test('contract/openapi.json ist aus contract/spec/ erzeugt (npm run contract:build)', () => {
  assert.equal(fs.readFileSync(OUT, 'utf8'), render());
});

test('version.json: zwei positive Ganzzahlen, nichts sonst', () => {
  assert.deepEqual(Object.keys(version).sort(), ['api', 'editorApi']);
  for (const v of Object.values(version)) assert.ok(Number.isInteger(v) && v > 0);
  assert.deepEqual(clientContract(), version);
});

test('CHANGELOG nennt den aktuellen Stand', () => {
  const log = fs.readFileSync(path.join(ROOT, 'contract', 'CHANGELOG.md'), 'utf8');
  assert.match(log, new RegExp(`^## api ${version.api}\\b`, 'm'), `contract/CHANGELOG.md braucht einen Abschnitt «## api ${version.api}»`);
  assert.match(log, new RegExp(`editorApi ${version.editorApi}\\b`), `contract/CHANGELOG.md muss editorApi ${version.editorApi} nennen`);
});

test('jede Operation sagt, welche Clients sie nutzen', () => {
  const spec = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  for (const [p, methods] of Object.entries(spec.paths)) {
    for (const [m, op] of Object.entries(methods)) {
      assert.ok(Array.isArray(op['x-clients']) && op['x-clients'].length, `${m.toUpperCase()} ${p}: x-clients fehlt`);
      for (const c of op['x-clients']) assert.ok(['macos', 'android'].includes(c), `${p}: unbekannter Client ${c}`);
    }
  }
});

test('X-Editor-Api: Liste von Majors, ohne Header gilt 1', () => {
  assert.deepEqual(parseEditorApiHeader('1'), [1]);
  assert.deepEqual(parseEditorApiHeader(' 1, 2 '), [1, 2]);
  assert.equal(parseEditorApiHeader(''), null);
  assert.equal(parseEditorApiHeader('abc'), null);
  assert.equal(parseEditorApiHeader(undefined), null);
  assert.equal(editorApiCompatible(undefined).ok, version.editorApi === 1);
  assert.equal(editorApiCompatible(String(version.editorApi)).ok, true);
  assert.equal(editorApiCompatible(`${version.editorApi + 1}`).ok, false);
  assert.deepEqual(editorApiCompatible('99').client, [99]);
});
