'use strict';
// Bundle-Vertrag (contract/README.md): jede Kontaktstelle, die macOS oder
// Android heute benutzen (contract/editor-surface.json), stellt das OTA-Bundle
// noch bereit. Läuft ohne Client-Repos — die deklarierte Fläche ist der Stand,
// den `npm run contract:surface` zuletzt aus beiden Clients gezogen hat; ob die
// Clients seither Neues anfassen, meldet `npm run check:clients`.
//
// Rot heisst: eine Änderung an public/js bricht einen ausgelieferten Client.
// Entweder die Stelle zurückholen — oder bewusst brechen: editorApi in
// contract/version.json erhöhen, CHANGELOG, Clients zuerst nachziehen.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadBundle, provides, requiredBridge, KINDS } = require('../../scripts/client-surface');
const { EDITOR_API } = require('../../lib/client-contract');

const ROOT = path.join(__dirname, '..', '..');
const surface = JSON.parse(fs.readFileSync(path.join(ROOT, 'contract', 'editor-surface.json'), 'utf8'));
const dts = fs.readFileSync(path.join(ROOT, 'contract', 'editor-api.d.ts'), 'utf8');

// Interna mit `_`, die ein Client heute noch anfasst. Jede Zeile ist eine
// Schuld beim Client, nicht hier: die Liste darf nur schrumpfen.
const INTERNAL_IN_USE = new Set([
  // macOS: Fallback in applyGranularity für Bundles ohne `setGranularity`.
  '_focusUpdateActive',
]);

let b;
test.before(async () => { b = await loadBundle(); });

test('Fläche gehört zum aktuellen Bundle-Major', () => {
  assert.equal(surface.editorApi, EDITOR_API,
    'editorApi erhöht? Dann Fläche neu ziehen (npm run contract:surface), nachdem die Clients umgestellt sind');
  assert.deepEqual(Object.keys(surface.surface).sort(), KINDS.map((k) => k.id).sort());
});

test('jede deklarierte Kontaktstelle stellt das Bundle bereit', () => {
  const missing = [];
  for (const [kind, entries] of Object.entries(surface.surface)) {
    for (const [name, clients] of Object.entries(entries)) {
      if (!provides(kind, name, b)) missing.push(`${kind} ${name} (genutzt von ${clients.join(', ')})`);
    }
  }
  assert.deepEqual(missing, [], 'Breaking Change für ausgelieferte Clients');
});

test('die Bridge verlangt nichts Neues von den Schalen', () => {
  assert.deepEqual(requiredBridge(b), surface.bridgeRequired,
    'Eine neue Pflicht-Funktion der Bridge bricht jede Schale, die sie nicht anbietet — optional machen oder editorApi erhöhen');
});

test('jede öffentliche Kontaktstelle steht in editor-api.d.ts', () => {
  const absent = [];
  const has = (name) => new RegExp(`\\b${name}\\b`).test(dts);
  for (const name of Object.keys(surface.surface.exports)) if (!has(name)) absent.push(`export ${name}`);
  for (const name of Object.keys(surface.surface.options)) {
    const [fn, key] = name.split('.');
    if (['bridge', 'mountStandaloneFocus'].includes(fn) && !has(key)) absent.push(`option ${name}`);
  }
  for (const name of Object.keys(surface.surface.members)) {
    if (!name.startsWith('_') && !has(name)) absent.push(`member ${name}`);
  }
  assert.deepEqual(absent, [], 'contract/editor-api.d.ts nachziehen');
});

test('Interna in Client-Benutzung nur aus der Schuldenliste', () => {
  const internal = Object.keys(surface.surface.members).filter((n) => n.startsWith('_'));
  const fresh = internal.filter((n) => !INTERNAL_IN_USE.has(n));
  assert.deepEqual(fresh, [], 'Ein Client greift auf ein `_`-Internum zu — öffentliche Handle-API anbieten (editor-api.d.ts) statt es zu deklarieren');
});
