// Tripwire fuer public/CLAUDE.md «Edit-Formulare: eine Tastaturbelegung»: das
// Speichern-Kuerzel Cmd/Ctrl+S wird nur in public/js/utils/keys.js erkannt
// (isSaveShortcut / handleEditPanelKeydown, im Template als `$editKeys`). Ein
// eigener `key === 's'`-Vergleich in einer Karte ist genau die Drift, die die
// Regel beseitigt hat. Ausgenommen: die drei Editoren (eigenes Kuerzel-System).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const JS_DIR = join(REPO_ROOT, 'public', 'js');
const HOME = 'public/js/utils/keys.js';
const EXEMPT_DIRS = ['public/js/editor/'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const SAVE_KEY_RE = /\bkey\s*===?\s*['"][sS]['"]|toLowerCase\(\)\s*===?\s*['"]s['"]/;

test('Cmd/Ctrl+S wird nur in utils/keys.js erkannt', () => {
  const offenders = [];
  for (const file of walk(JS_DIR)) {
    const rel = relative(REPO_ROOT, file);
    if (rel === HOME || EXEMPT_DIRS.some(d => rel.startsWith(d))) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (SAVE_KEY_RE.test(line)) offenders.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `Eigener Cmd+S-Vergleich — isSaveShortcut bzw. $editKeys nutzen:\n${offenders.join('\n')}`);
});

test('$editKeys ist als Magic registriert und nutzt den geteilten Handler', () => {
  const src = readFileSync(join(JS_DIR, 'app', 'register-cards.js'), 'utf8');
  assert.match(src, /Alpine\.magic\('editKeys', \(\) => handleEditPanelKeydown\)/);
});
