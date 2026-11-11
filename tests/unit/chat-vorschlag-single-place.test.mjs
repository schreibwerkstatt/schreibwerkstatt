// Gate fuer die Vorschlagskarte der Chats (DESIGN.md „Chat-Vorschlagskarte",
// components/chat-vorschlag.css): Abschnitts-, Plot-, Ideen- und Recherche-Chat
// zeigen Vorschlaege mit EINER Optik — Kopf, Feldzeilen, Wechsel alt → neu,
// Beleg, Hinweis.
//
// Geprueft wird:
//   1. `.chat-vorschlag*` wird nur in chat-vorschlag.css gestylt.
//   2. Kein Chat baut die Innenteile unter eigenem Namen nach
//      (`.<chat>-proposal-row/-field/-meta/-note/-text`, `.<chat>-change-row/…`).
//   3. Ein Feldwechsel in einer Vorschlagskarte ist `.chat-vorschlag-change`,
//      nicht das Lektorat-Pillenpaar `.finding-original`/`.finding-korrektur`
//      (rot/gruen gestapelt liest sich «Offen → Erledigt» als Korrektur).
//      Ausnahme: der Abschnitts-Chat — dort IST der Vorschlag eine
//      Textkorrektur, die Pillen sind der Fallback ohne Wort-Diff.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const rel = (f) => relative(ROOT, f);
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

function walk(dir, ext, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { if (entry !== 'vendor') walk(full, ext, out); }
    else if (entry.endsWith(ext)) out.push(full);
  }
  return out;
}

const OWNER = 'public/css/components/chat-vorschlag.css';
const cssFiles = walk(join(ROOT, 'public/css'), '.css');

test('.chat-vorschlag* wird nur in chat-vorschlag.css gestylt', () => {
  const bad = cssFiles
    .filter(f => rel(f) !== OWNER)
    .filter(f => /\.chat-vorschlag/.test(stripCss(readFileSync(f, 'utf8'))))
    .map(rel);
  assert.deepEqual(bad, [], 'eigenes Styling der Vorschlagskarte — gehoert nach components/chat-vorschlag.css');
});

test('kein Chat baut Feldzeile/Meta/Hinweis unter eigenem Namen nach', () => {
  const re = /\.[a-z-]*chat-(?:proposal|change)-(?:row|field|meta|note|text)\b/;
  const bad = cssFiles.filter(f => re.test(stripCss(readFileSync(f, 'utf8')))).map(rel);
  assert.deepEqual(bad, [], 'Innenteil der Vorschlagskarte nachgebaut — .chat-vorschlag-row/-field/-meta/-note/-text nehmen');
});

const PILL_ALLOW = new Set([
  // Abschnitts-Chat: Textkorrektur, Pillen als Fallback ohne Wort-Diff.
  'public/partials/chat-vorschlaege.html',
]);

test('Feldwechsel in Vorschlagskarten nur ueber .chat-vorschlag-change', () => {
  const partials = walk(join(ROOT, 'public/partials'), '.html')
    .filter(f => /class="chat-vorschlag"/.test(readFileSync(f, 'utf8')));
  assert.ok(partials.length >= 4, 'Konsumenten nicht gefunden — Gate pruefen');
  const bad = partials
    .filter(f => !PILL_ALLOW.has(rel(f)))
    .filter(f => /finding-(?:original|korrektur)/.test(readFileSync(f, 'utf8')))
    .map(rel);
  assert.deepEqual(bad, [], 'Lektorat-Pillen in einer Vorschlagskarte — alt → neu als .chat-vorschlag-change');
});
