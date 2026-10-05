// Unit: die Welt-Fakten-Kategorien stehen an fünf Orten — sie müssen deckungsgleich
// bleiben. Whitelist (db/world-facts.js#FAKT_KATEGORIE_WL) normalisiert den Schreibpfad,
// das Prompt-Enum (FAKTEN_SCHEMA) sagt der KI, was sie liefern darf, die Karte
// (KAT_ORDER) gruppiert, das Buch-Chat-Werkzeug nennt dem Agenten die Filterwerte, und
// die Labels kommen aus weltfakten.kategorie.* in beiden Locales. Eine Kategorie, die
// nur an einem Ort neu ist, fällt still auf 'sonstiges' zurück oder rendert ohne Label.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('wf-kat-drift');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { FAKT_KATEGORIE_WL } = require('../../db/world-facts');
const { FAKTEN_SCHEMA } = await import('../../public/js/prompts/komplett/schema-strings.js');
const { BOOK_CHAT_TOOLS } = await import('../../public/js/prompts/book-chat-tools.js');

const WL = [...FAKT_KATEGORIE_WL];
const sorted = (a) => [...a].sort();

test('KAT_ORDER der Karte = Whitelist (gleiche Reihenfolge)', () => {
  // Quelltext statt Import: die Karte zieht Alpine-/DOM-Module nach.
  const src = read('public/js/cards/world-facts-card.js');
  const m = src.match(/export const KAT_ORDER = \[([\s\S]*?)\];/);
  assert.ok(m, 'KAT_ORDER nicht gefunden');
  const katOrder = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  assert.deepStrictEqual(katOrder, WL);
});

test('FAKTEN_SCHEMA-Enum = Whitelist', () => {
  const m = FAKTEN_SCHEMA.match(/"kategorie":\s*"([^"]+)"/);
  assert.ok(m, 'kategorie-Enum im FAKTEN_SCHEMA nicht gefunden');
  assert.deepStrictEqual(sorted(m[1].split('|')), sorted(WL));
});

test('list_world_facts-Werkzeug nennt genau die Whitelist', () => {
  const tool = BOOK_CHAT_TOOLS.find(t => t.name === 'list_world_facts');
  const desc = tool.input_schema.properties.kategorie.description;
  const m = desc.match(/Gültige Werte:\s*([^.]+)\./);
  assert.ok(m, 'Werteliste in der kategorie-Beschreibung nicht gefunden');
  assert.deepStrictEqual(sorted(m[1].split(',').map(s => s.trim())), sorted(WL));
});

for (const loc of ['de', 'en']) {
  test(`i18n ${loc}: weltfakten.kategorie.* = Whitelist`, () => {
    const json = JSON.parse(read(`public/js/i18n/${loc}.json`));
    const keys = Object.keys(json)
      .filter(k => k.startsWith('weltfakten.kategorie.'))
      .map(k => k.slice('weltfakten.kategorie.'.length));
    assert.deepStrictEqual(sorted(keys), sorted(WL));
  });
}
