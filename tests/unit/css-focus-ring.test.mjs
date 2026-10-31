// Fokus-Gate: wer die Browser-Outline abschaltet, liefert ein Ersatzsignal.
//
// WARUM: `outline: none` + Hover-Toenung sieht beim Klicken richtig aus und
// laesst Tastatur-Nutzer blind — der Hover-Hintergrund erscheint bei Tab-Fokus
// nicht oder ist von der Auswahl nicht zu unterscheiden. Regel (DESIGN.md
// „Focus-Visible", css/CLAUDE.md): jede Regel mit `outline: none|0` setzt im
// SELBEN Block entweder den Fokus-Ring (`var(--focus-ring)`) oder — bei
// Eingabefeldern — den Fokus-Rahmen (`var(--color-border-focus)`, >= 3:1).
// Schreibflaechen, bei denen der Caret das Signal ist, stehen begruendet in ALLOW.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const CSS_DIR = join(ROOT, 'public', 'css');

// share/ hat ein eigenes Token-Universum (--share-*), ohne --focus-ring.
const EXCLUDED = ['css/share/', 'css/share.css'];

// `datei|selektor` → Begruendung. Nur Schreibflaechen und Felder, die als Text
// im Satzspiegel stehen: der blinkende Caret ist dort das Fokus-Signal, ein Ring
// um den Text waere laut und braeche den Gleichlauf mit der Leseansicht.
const ALLOW = new Map([
  ['css/editor/focus/focus-mode.css|.focus-editor__content', 'Focus-Editor-Schreibflaeche (contenteditable), Caret ist das Signal'],
  ['css/editor/book/book-editor.css|.book-editor-page-body', 'Bucheditor-Schreibflaeche (contenteditable), Caret ist das Signal'],
  ['css/editor/book/book-editor.css|.book-editor-page-body[contenteditable="true"]:focus-visible', 'Bucheditor-Schreibflaeche: Toenung + Caret'],
  ['css/editor/book/book-editor-head.css|.book-editor-head__field', 'Bucheditor-Kopffelder im Satzspiegel (Dachzeile/Titel/Lead), Toenung + Caret'],
  ['css/page/page-view.css|.page-content-view--editing', 'Notebook-Edit-Modus: Rail links + Toenung markieren die Schreibflaeche'],
  ['css/editor/notebook/page-head.css|.page-head .page-head__input:focus', 'Abschnittstitel im Blatt: Toenung + Caret, Ring braeche den Gleichlauf mit der Leseansicht'],
]);

const SIGNAL_RE = /var\(--(focus-ring|color-border-focus)\b/;
const OFF_RE = /(?<![\w-])outline\s*:\s*(none|0)\s*(!important)?\s*(;|$)/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (e.endsWith('.css')) out.push(f);
  }
  return out;
}

export function outlineOffBlocks(src) {
  const css = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!OFF_RE.test(m[2])) continue;
    const selector = m[1].trim().replace(/\s+/g, ' ');
    out.push({ selector, ok: SIGNAL_RE.test(m[2]), line: css.slice(0, m.index + m[0].indexOf('{')).split('\n').length });
  }
  return out;
}

test('outline: none nur mit Ersatz-Fokussignal (--focus-ring / --color-border-focus)', () => {
  const fails = [];
  const used = new Set();
  for (const f of walk(CSS_DIR)) {
    const r = relative(join(ROOT, 'public'), f).split('\\').join('/');
    if (EXCLUDED.some((e) => r.startsWith(e))) continue;
    for (const b of outlineOffBlocks(readFileSync(f, 'utf8'))) {
      if (b.ok) continue;
      const key = `${r}|${b.selector}`;
      if (ALLOW.has(key)) { used.add(key); continue; }
      fails.push(`${r}:${b.line} „${b.selector}" — outline: none ohne Ersatz. ` +
        `:focus-visible { outline: var(--focus-ring); outline-offset: var(--focus-ring-offset[-inset]); } ` +
        `bzw. Eingabefeld: border-color: var(--color-border-focus)`);
    }
  }
  for (const k of ALLOW.keys()) if (!used.has(k)) fails.push(`ALLOW-Eintrag ohne Treffer (entfernen): ${k}`);
  assert.equal(fails.length, 0, `Fokus-Signal fehlt:\n  ${fails.join('\n  ')}`);
});
