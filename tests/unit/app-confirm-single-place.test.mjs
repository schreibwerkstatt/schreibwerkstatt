// Gate fuer Rueckfragen (public/CLAUDE.md „Rueckfrage nur via appConfirm"):
// jede Rueckfrage, jeder Hinweis und jede Texteingabe im Modal laeuft ueber
// `appConfirm`/`appAlert`/`appPrompt` (app-chrome.js, natives <dialog>). Das
// native `confirm()`/`alert()`/`prompt()` reisst Chrome auf macOS aus dem
// Vollbild-Space und sieht anders aus als jede andere Rueckfrage der App.
//
// Ausnahme: der Share-Reader (public/js/share-reader*) — eigene SSR-Seite ohne
// Alpine und ohne den Dialog aus index.html.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const PUBLIC = join(REPO_ROOT, 'public');
const SKIP_DIRS = new Set(['vendor', 'fonts']);
const rel = (p) => relative(REPO_ROOT, p);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|mjs|html)$/.test(entry)) out.push(full);
  }
  return out;
}

const isExempt = (p) => /^public\/js\/share-reader(\.js|\/)/.test(rel(p));

// `confirm(`, `window.confirm(`, ebenso alert/prompt — aber nicht `.confirm(`
// an einem anderen Objekt, `appConfirm(`, `_resolveConfirm(` o. ae.
const NATIVE = /(?:^|[^.\w$])(?:window\.)?(confirm|alert|prompt)\s*\(/;

function stripComments(line) {
  const i = line.indexOf('//');
  return i >= 0 && !/https?:\/\/$/.test(line.slice(0, i + 2)) ? line.slice(0, i) : line;
}

test('kein natives confirm()/alert()/prompt() ausserhalb des Share-Readers', () => {
  const hits = [];
  for (const file of walk(PUBLIC)) {
    if (isExempt(file) || rel(file) === 'public/sw-manifest.js') continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const code = stripComments(line);
      if (/^\s*\*/.test(code)) return;
      const m = code.match(NATIVE);
      if (m) hits.push(`${rel(file)}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [],
    `Natives ${'confirm'}()/alert()/prompt() gefunden — stattdessen ` +
    '`await $app.appConfirm({ message, danger? })` / `appAlert` / `appPrompt`:\n' + hits.join('\n'));
});
