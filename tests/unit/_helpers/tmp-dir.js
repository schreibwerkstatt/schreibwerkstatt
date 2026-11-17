'use strict';
// Wegwerf-Verzeichnisse fuer Unit-Tests, die sich selbst wegraeumen.
//
//   const { makeTmpDir } = require('./_helpers/tmp-dir');      // CJS
//   import { makeTmpDir } from './_helpers/tmp-dir.js';         // ESM
//   const dir = makeTmpDir('bundle-test-');
//
// Jedes Verzeichnis wird registriert und nach dem letzten Test des Files
// (Root-after-Hook) bzw. beim Prozess-Ende rekursiv geloescht — auch wenn ein
// Test vorher an einer Assertion scheitert und sein eigenes teardown() nie
// erreicht. Ein zusaetzliches teardown()/rmSync im Test bleibt erlaubt
// (frueher freigeben), ist aber nicht mehr noetig.
//
// Why zentral: /tmp ist auf den Entwicklungsrechnern ein RAM-tmpfs. Ein
// `mkdtempSync` ohne Aufraeumen pro Test-File laesst bei jeder
// `npm run test:unit`-Runde DBs samt WAL bzw. ganze Git-Repos liegen, bis /tmp
// voll ist und Shell, Editor und Tests mit ENOSPC ausfallen. Nur dieser Helper
// darf in tests/unit mkdtemp aufrufen — gegated in tmp-dir-cleanup.test.mjs.
// Fuer eine reine Wegwerf-SQLite gibt es ./tmp-db.js (useTmpDb).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { after } = require('node:test');

const dirs = new Set();

function removeAll() {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* weg ist weg */ }
  }
  dirs.clear();
}

// Beim Laden registriert (Modul-Ebene des Test-Files), damit der Hook am Root
// haengt und nicht am gerade laufenden Test.
after(removeAll);
process.once('exit', removeAll);

/**
 * Legt ein eindeutiges Verzeichnis unter os.tmpdir() an und registriert es
 * zum Loeschen.
 * @param {string} [prefix] Namens-Praefix (Diagnose bei Resten), z.B. 'bundle-test-'.
 * @returns {string} absoluter Pfad
 */
function makeTmpDir(prefix = 'unit-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.add(dir);
  return dir;
}

module.exports = { makeTmpDir };
