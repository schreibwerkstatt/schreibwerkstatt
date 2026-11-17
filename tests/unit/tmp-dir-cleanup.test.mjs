// Gate: Wegwerf-Verzeichnisse in Unit-Tests nur über tests/unit/_helpers/tmp-dir.js
// (makeTmpDir), Wegwerf-DBs über _helpers/tmp-db.js (useTmpDb). Beide räumen per
// Root-after() und beim Prozess-Ende ab — auch wenn ein Test vorher scheitert.
// Ein direktes mkdtemp(Sync) lässt sonst bei jeder Unit-Runde Verzeichnisse in
// /tmp (RAM-tmpfs) liegen, bis es voll ist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UNIT = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(UNIT, '_helpers', 'tmp-dir.js');
const SELF = fileURLToPath(import.meta.url);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p);
    return /\.(m?js|cjs)$/.test(e.name) ? [p] : [];
  });
}

test('kein direktes mkdtemp in tests/unit — nur makeTmpDir aus _helpers/tmp-dir.js', () => {
  const offenders = [];
  for (const file of walk(UNIT)) {
    if (file === HELPER || file === SELF) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/\bmkdtemp(Sync)?\s*\(/.test(line)) offenders.push(`${path.relative(UNIT, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], 'mkdtemp ohne Aufräumen — makeTmpDir() bzw. useTmpDb() verwenden');
});
