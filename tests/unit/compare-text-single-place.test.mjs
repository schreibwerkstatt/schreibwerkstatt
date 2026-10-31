// Textsortierung (i18n.js#compareText): Kollation der UI-Sprache, numerisch,
// Gross/Klein und Akzente gleichrangig. Gate: Anzeige-Texte sortiert nur
// compareText — ein nacktes `localeCompare` sortiert in der Browser-Sprache
// (oder fest auf 'de') und ohne Zahlen-Sortierung («Kapitel 10» vor «Kapitel 2»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const { compareText } = await import('../../public/js/i18n.js');

test('compareText: Zahlen numerisch, Umlaut beim Grundbuchstaben, null als leer', () => {
  assert.deepEqual(['Kapitel 10', 'Kapitel 2', 'Kapitel 1'].sort(compareText), ['Kapitel 1', 'Kapitel 2', 'Kapitel 10']);
  assert.deepEqual(['Zürich', 'Ärger', 'Bern', 'apfel'].sort(compareText), ['apfel', 'Ärger', 'Bern', 'Zürich']);
  assert.equal(compareText('a', 'A'), 0);
  assert.ok(compareText(null, 'a') < 0);
  assert.equal(compareText(undefined, ''), 0);
});

// Begründete Ausnahmen: verglichen werden keine Anzeige-Texte der UI-Sprache.
const ALLOW = {
  'public/js/country-codes.js': 'Ländernamen in der ausdrücklich übergebenen Label-Sprache',
  'public/js/editor/notebook/entities.js': 'Datums-Strings, roher Vergleich',
  'public/js/book/orte-insights.js': 'Tie-Break über IDs',
  'public/js/book/recherche/board.js': 'ISO-Zeitstempel',
  'public/js/book/diary-calendar.js': 'ISO-Tages-Keys',
};

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'vendor') yield* walk(p); }
    else if (name.endsWith('.js')) yield p;
  }
}

test('kein localeCompare/Intl.Collator für Anzeige-Texte ausserhalb von compareText', () => {
  const treffer = [];
  for (const file of walk(join(ROOT, 'public', 'js'))) {
    const rel = file.slice(ROOT.length + 1);
    // sources/format/: Literaturverzeichnis sortiert in der Zitiersprache des Buchs, nicht der UI.
    if (rel === 'public/js/i18n.js' || rel.startsWith('public/js/sources/format/') || ALLOW[rel]) continue;
    const src = readFileSync(file, 'utf8');
    if (/\.localeCompare\(|new Intl\.Collator\(/.test(src)) treffer.push(rel);
  }
  assert.deepEqual(treffer, [], 'Anzeige-Texte über compareText (i18n.js) sortieren:\n  ' + treffer.join('\n  '));
});
