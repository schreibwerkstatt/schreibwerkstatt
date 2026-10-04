// Schauplatz-Typen: die Frontend-Liste (book/ort-typen.js) muss jedes Typ-Enum
// des Analyse-Schemas decken und jeder Typ braucht ein Label in beiden Locales —
// sonst zeigt die Karte einen rohen Persistenz-Key (z.B. «gebaeude»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ORT_TYPEN, ortTypLabel } from '../../public/js/book/ort-typen.js';
import { ORTE_SCHEMA } from '../../public/js/prompts/komplett/schema-strings.js';

const de = JSON.parse(readFileSync(new URL('../../public/js/i18n/de.json', import.meta.url), 'utf8'));
const en = JSON.parse(readFileSync(new URL('../../public/js/i18n/en.json', import.meta.url), 'utf8'));

test('ORT_TYPEN deckt das typ-Enum des Orte-Schemas', () => {
  const m = ORTE_SCHEMA.match(/"typ":\s*"([^"]+)"/);
  assert.ok(m, 'typ-Enum im ORTE_SCHEMA nicht gefunden');
  for (const t of m[1].split('|')) assert.ok(ORT_TYPEN.includes(t), `Typ «${t}» fehlt in ORT_TYPEN`);
});

test('jeder Typ hat ein Label in de und en', () => {
  for (const t of ORT_TYPEN) {
    assert.ok(de['orte.typ.' + t], `de: orte.typ.${t} fehlt`);
    assert.ok(en['orte.typ.' + t], `en: orte.typ.${t} fehlt`);
  }
});

test('ortTypLabel: bekannter Typ übersetzt, leer = andere, unbekannt bleibt lesbar', () => {
  const t = (k) => de[k];
  assert.equal(ortTypLabel('gebaeude', t), 'Gebäude');
  assert.equal(ortTypLabel('', t), 'andere');
  assert.equal(ortTypLabel('hafen', t), 'hafen');
});
