// Drift-Gate: Befund-Typen der Kontinuitätsprüfung. Prompt-Enum (KONTINUITAET_TYPEN) ==
// Schema-Enum == Server-Spiegel (remap.js), jeder Typ mit Label in beiden Locales.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';


const { KONTINUITAET_TYPEN, PROBLEME_SCHEMA } = await import('../../public/js/prompts/komplett/schema-strings.js');
const { SCHEMA_KONTINUITAET_PROBLEME } = await import('../../public/js/prompts/komplett/schemas.js');

test('Schema-Enum == Prompt-Enum, entwarnung Pflichtfeld', () => {
  const item = SCHEMA_KONTINUITAET_PROBLEME.properties.probleme.items;
  assert.deepEqual(item.properties.typ.enum, KONTINUITAET_TYPEN);
  assert.ok(item.required.includes('entwarnung'));
  assert.ok(PROBLEME_SCHEMA.includes(KONTINUITAET_TYPEN.join('|')));
});

test('Server-Spiegel in remap.js deckt alle Prompt-Typen ab (+ faktenfehler)', () => {
  // Nur die Konstante lesen, ohne remap.js (und damit die DB) zu laden.
  const src = readFileSync(new URL('../../routes/jobs/komplett/remap.js', import.meta.url), 'utf8');
  const m = src.match(/const KONTINUITAET_TYPEN = \[([\s\S]*?)\];/);
  assert.ok(m, 'KONTINUITAET_TYPEN in remap.js');
  const server = [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
  assert.deepEqual(server.filter(t => t !== 'faktenfehler'), KONTINUITAET_TYPEN);
  assert.ok(server.includes('faktenfehler'));
});

test('jeder Typ hat kontinuitaet.typ.* in de.json und en.json', () => {
  for (const loc of ['de', 'en']) {
    const dict = JSON.parse(readFileSync(new URL(`../../public/js/i18n/${loc}.json`, import.meta.url), 'utf8'));
    for (const t of [...KONTINUITAET_TYPEN, 'faktenfehler']) {
      assert.ok(dict[`kontinuitaet.typ.${t}`], `${loc}: kontinuitaet.typ.${t}`);
    }
  }
});

