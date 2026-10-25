// Drift-Gate: Kapitel-/Abschnitts-Filter arbeiten auf IDs, nie auf Namen.
//
// Why: gleichnamige Kapitel («Einleitung» in Teil I und Teil II) und gleichnamige
// Abschnitte sind verschiedene Orte. Ein Filter auf den Namen legt sie zusammen,
// eine Name→ID-Rückübersetzung muss raten — und ein KI-Kapitelname kann sogar
// einen gleichnamigen Abschnitt meinen. Regel + Begründung: docs/chapter-hierarchy.md
// («Kapitel und Abschnitte per ID, nie per Name»).
//
// Geprüft wird die Form, die jede Karte einhält:
//  1. Jede Kapitel-/Abschnitts-Combobox (catalogFilter('chapter'|'page')) bindet ein
//     Feld, das auf `KapitelId`/`kapitelId`/`seiteId` endet — und baut ihre Optionen
//     nicht als {value: name, label: name}.
//  2. Kein persistierter Filter-Scope führt mehr ein Namensfeld `kapitel`/`seite`.
//  3. Server: keine eigene Name→ID-Map über `chapter_name` — die liefert
//     write-helpers.js#chapterNameMap, die mehrdeutige Namen auslässt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'vendor' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some(e => name.endsWith(e))) out.push(p);
  }
  return out;
}

const htmlFiles = [...walk(join(ROOT, 'public/partials'), ['.html']), join(ROOT, 'public/index.html')];

// Ein Combobox-Wrapper ist ein <div …> bis zum schliessenden `>` des Start-Tags.
function chapterComboboxes() {
  const out = [];
  for (const file of htmlFiles) {
    const src = readFileSync(file, 'utf8');
    // Attribute quote-sicher überspringen (`x-show="beats.length > 0"` enthält `>`).
    const re = /<div\b(?:[^>"]|"[^"]*")*>/gs;
    let m;
    while ((m = re.exec(src))) {
      const kind = /x-data="catalogFilter\('(chapter|page)'\)"/.exec(m[0])?.[1];
      if (kind) out.push({ file: relative(ROOT, file), kind, tag: m[0] });
    }
  }
  return out;
}

test('jede Kapitel-/Abschnitts-Combobox bindet ein ID-Feld', () => {
  const boxes = chapterComboboxes();
  assert.ok(boxes.length >= 8, `zu wenige Kapitel-Filter gefunden (${boxes.length}) — Regex veraltet?`);
  const bad = [];
  for (const b of boxes) {
    const model = /x-model="([^"]+)"/.exec(b.tag)?.[1] || '';
    if (!/(kapitelId|KapitelId|seiteId)$/.test(model)) bad.push(`${b.file}: x-model="${model}"`);
    if (/\(\s*\{\s*value:\s*(\w+),\s*label:\s*\1\s*\}\s*\)/.test(b.tag)) bad.push(`${b.file}: Optionen {value: name, label: name}`);
  }
  assert.deepEqual(bad, [], 'Kapitel-/Abschnittsfilter auf Namen statt IDs:\n' + bad.join('\n'));
});

test('persistierte Filter-Scopes führen keine Namensfelder kapitel/seite', () => {
  const files = walk(join(ROOT, 'public/js'), ['.js']);
  const bad = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/defaults:\s*\{([^}]*)\}/g)) {
      if (/\b(kapitel|seite)\s*:/.test(m[1])) bad.push(`${relative(ROOT, file)}: ${m[0]}`);
    }
    for (const m of src.matchAll(/\b\w+Filters\s*:\s*\{([^}]*)\}/g)) {
      if (/\b(kapitel|seite)\s*:/.test(m[1])) bad.push(`${relative(ROOT, file)}: ${m[0]}`);
    }
  }
  assert.deepEqual(bad, [], 'Filter-Felder kapitel/seite (Namen) statt kapitelId/seiteId:\n' + bad.join('\n'));
});

test('Server: Kapitelname→ID nur über chapterNameMap (mehrdeutige Namen lösen nicht auf)', () => {
  const files = ['db', 'routes', 'lib'].flatMap(d => walk(join(ROOT, d), ['.js']))
    .filter(f => !f.endsWith('squashed-schema.js') && !f.endsWith('migrations.js'));
  const bad = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    if (/\[\s*\w+\.chapter_name\s*,\s*\w+\.chapter_id\s*\]/.test(src)) bad.push(relative(ROOT, file));
  }
  assert.deepEqual(bad, [], 'Eigene Name→ID-Map über chapter_name (raten bei Namensgleichheit):\n' + bad.join('\n'));
});
