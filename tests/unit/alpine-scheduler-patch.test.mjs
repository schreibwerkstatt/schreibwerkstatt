// Gate: die eingebundene Alpine-Datei trägt den Scheduler-Requeue-Patch
// (docs/architektur.md#alpine-scheduler-patch). Wer Alpine aktualisiert und die
// neue Datei unverändert ablegt, wird hier in Sekunden rot — nicht erst in der
// E2E-Suite (tests/e2e-app/x-show-guard.spec.js prüft das Verhalten).
//
// Geprüft wird über Muster statt über Minifizierungs-Namen: die Kurznamen
// (`ai`, `ci`, `B`, `vt`) ändern sich mit jedem Alpine-Release.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const VENDOR = join(ROOT, 'public', 'vendor');
const CORE_RE = /^alpine-\d+\.\d+\.\d+\.min\.js$/;

export function patchProblems(src) {
  const problems = [];
  if (!src.startsWith('/* schreibwerkstatt-Patch (Scheduler-Requeue)')) {
    problems.push('Kopfkommentar mit Verweis auf docs/architektur.md fehlt');
  }
  if (!/[,;{]\s*__swRequeue=0[,;]/.test(src)) {
    problems.push('Deklaration `__swRequeue=0` fehlt');
  }
  // Einreihen: erst ab dem laufenden Index suchen, gedeckelt auf 2000 Requeues.
  if (!/(\w+)\.includes\((\w+),(\w+)\+1\)\|\|\1\.includes\(\2\)&&\+\+__swRequeue>2e3\|\|\(\1\.push\(\2\)/.test(src)) {
    problems.push('Bedingung `Q.includes(e, idx+1) || Q.includes(e) && ++__swRequeue > 2e3 || Q.push(e)` fehlt');
  }
  // Rücksetzen am Ende des Flushs.
  if (!/,__swRequeue=0\}/.test(src)) {
    problems.push('Rücksetzen `__swRequeue=0` am Ende des Flushs fehlt');
  }
  return problems;
}

test('index.html bindet genau eine Alpine-Kerndatei aus vendor/ ein', () => {
  const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
  const refs = [...html.matchAll(/src="vendor\/(alpine-\d+\.\d+\.\d+\.min\.js)"/g)].map(m => m[1]);
  assert.equal(refs.length, 1, `erwartet eine Alpine-Kerndatei, gefunden: ${refs.join(', ') || 'keine'}`);
});

test('jede Alpine-Kerndatei in public/vendor/ trägt den Scheduler-Patch', () => {
  const cores = readdirSync(VENDOR).filter(f => CORE_RE.test(f));
  assert.ok(cores.length > 0, 'keine Alpine-Kerndatei in public/vendor/ gefunden');
  for (const f of cores) {
    const problems = patchProblems(readFileSync(join(VENDOR, f), 'utf8'));
    assert.deepEqual(problems, [],
      `${f}: Scheduler-Patch fehlt oder ist unvollständig — nachziehen laut docs/architektur.md#alpine-scheduler-patch:\n  - ${problems.join('\n  - ')}`);
  }
});
