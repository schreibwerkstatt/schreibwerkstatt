// Invariante: Entity-Linking-Highlights schreiben NIE Markup ins Editor-DOM.
// Plan-Regel "Gespeichertes Seiten-HTML enthaelt keinerlei Entity-Linking-
// Markup" beruht darauf, dass `entities.js` ausschliesslich die CSS Custom
// Highlight API benutzt — also keine DOM-Mutation, kein neuer Knoten, kein
// innerHTML-Eingriff, kein Klassen-Setzen am Editor.
//
// Wir testen das statisch: das Modul darf keine der bekannten Mutations-APIs
// am Editor-Element verwenden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(__dirname, '../../public/js/editor/notebook/entities.js');

const FORBIDDEN_PATTERNS = [
  /\.innerHTML\s*=/,
  /\.outerHTML\s*=/,
  /insertAdjacentHTML\s*\(/,
  /insertAdjacentElement\s*\(/,
  /\.appendChild\s*\(/,
  /\.insertBefore\s*\(/,
  /\.replaceChild\s*\(/,
  /createElement\s*\(\s*['"](?!div\b)/, // erlauben document.createElement nur fuer ungenutzte/erlaubte Tags — siehe Whitelist
  /document\.execCommand\s*\(/,
  /\.setAttribute\s*\(/,
  /\.classList\.(add|remove|toggle|replace)\s*\(/,
  /\.className\s*=/,
];

test('entities.js benutzt keine DOM-Mutation am Editor-Inhalt', async () => {
  const src = await readFile(MODULE_PATH, 'utf8');
  for (const re of FORBIDDEN_PATTERNS) {
    const m = src.match(re);
    assert.equal(m, null, `Verbotener Pattern in entities.js gefunden: ${re}\nMatch: ${m?.[0]}`);
  }
});

test('entities.js benutzt die CSS Custom Highlight API', async () => {
  const src = await readFile(MODULE_PATH, 'utf8');
  // Registrierung über den geteilten Helfer (editor/shared/highlights.js).
  assert.match(src, /registerHighlight\(\s*HL_FIGURE/, 'Figuren-Highlight nicht registriert');
  assert.match(src, /registerHighlight\(\s*HL_LOCATION/, 'Orte-Highlight nicht registriert');
});

test('entities.js arbeitet read-only mit Range-Objekten', async () => {
  const src = await readFile(MODULE_PATH, 'utf8');
  // Range#deleteContents/extractContents/insertNode etc. waeren mutierend.
  assert.doesNotMatch(src, /\.deleteContents\b/);
  assert.doesNotMatch(src, /\.extractContents\b/);
  assert.doesNotMatch(src, /\.insertNode\b/);
  assert.doesNotMatch(src, /\.surroundContents\b/);
});
