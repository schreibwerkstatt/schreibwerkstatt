// Zähl-Texte (i18n.js): `tn(key, n)` / `pluralKey(key, n)` wählen `<key>One` bei
// Einzahl nach Intl.PluralRules der UI-Sprache, sonst `<key>`; `{n}` kommt
// locale-formatiert. Drift-Guard: jeder Literal-Key an `tn`/`pluralKey` hat
// beide Formen in beiden Locales — sonst stünde bei n = 1 der rohe Key im UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const LOCALES = {
  de: JSON.parse(readFileSync(join(ROOT, 'public/js/i18n/de.json'), 'utf8')),
  en: JSON.parse(readFileSync(join(ROOT, 'public/js/i18n/en.json'), 'utf8')),
};

globalThis.fetch = async (url) => {
  const loc = /\/(\w+)\.json$/.exec(String(url))[1];
  return { ok: true, json: async () => LOCALES[loc] };
};
const { configureI18n, tnRaw, pluralKey } = await import('../../public/js/i18n.js');

test('pluralKey: Einzahl nur bei genau eins (auch negativ), null ist Mehrzahl', async () => {
  for (const loc of ['de', 'en']) {
    await configureI18n(loc);
    assert.equal(pluralKey('x', 1), 'xOne');
    assert.equal(pluralKey('x', -1), 'xOne');
    assert.equal(pluralKey('x', 0), 'x');
    assert.equal(pluralKey('x', 2), 'x');
    assert.equal(pluralKey('x', 1.5), 'x');
  }
});

test('tnRaw: Variante nach Anzahl, {n} locale-formatiert, weitere Platzhalter bleiben', async () => {
  await configureI18n('de');
  assert.equal(tnRaw('sidebar.pagesCount', 1), LOCALES.de['sidebar.pagesCountOne']);
  assert.equal(tnRaw('sidebar.pagesCount', 1200), LOCALES.de['sidebar.pagesCount'].replace('{n}', new Intl.NumberFormat('de-CH').format(1200)));
  await configureI18n('en');
  assert.equal(tnRaw('sidebar.pagesCount', 1200), LOCALES.en['sidebar.pagesCount'].replace('{n}', new Intl.NumberFormat('en-US').format(1200)));
  assert.equal(tnRaw('mystats.bookGoals.pace', 3, { chars: 'X' }).includes('X'), true);
});

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'vendor' && name !== 'i18n') yield* walk(p); }
    else if (/\.(js|html)$/.test(name)) yield p;
  }
}

test('jeder Literal-Key an tn/pluralKey hat <key> und <key>One in de und en', () => {
  const re = /\b(?:tn|tnRaw|pluralKey)\(\s*'([\w.]+)'/g;
  const missing = [];
  let seen = 0;
  for (const file of walk(join(ROOT, 'public'))) {
    for (const [, key] of readFileSync(file, 'utf8').matchAll(re)) {
      seen++;
      for (const [loc, msgs] of Object.entries(LOCALES)) {
        for (const k of [key, key + 'One']) if (!(k in msgs)) missing.push(`${loc}: ${k} (${file.slice(ROOT.length + 1)})`);
      }
    }
  }
  assert.ok(seen > 10, 'Scanner findet keine Aufrufe mehr');
  assert.deepEqual(missing, []);
});
