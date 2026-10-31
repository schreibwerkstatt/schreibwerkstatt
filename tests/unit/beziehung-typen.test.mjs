// Beziehungstypen der Figuren (public/js/book/beziehung-typen.js): Bereinigung der
// KI-Ausgabe und Drift-Gate der Kette Liste ↔ Graph-Styling ↔ Prompt ↔ Schema ↔ i18n.
// Ein Typ, den ein Teil nicht kennt, landet sonst als roher i18n-Key im Tooltip
// oder als graue Standardkante im Graph.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const { RELATION_TYPES, normalizeRelationTyp, normalizeRelationTypes } =
  await import('../../public/js/book/beziehung-typen.js');

test('gültiger Typ bleibt unverändert', () => {
  for (const t of RELATION_TYPES) assert.deepEqual(normalizeRelationTyp(t), { typ: t, original: null });
});

test('abgeschriebenes «a|b»: «andere» zählt nur, wenn sonst nichts bleibt', () => {
  assert.equal(normalizeRelationTyp('andere|bekannt').typ, 'bekannt');
  assert.equal(normalizeRelationTyp('bekannt|andere').typ, 'bekannt');
  assert.equal(normalizeRelationTyp('kollege|bekannt').typ, 'kollege');
  assert.equal(normalizeRelationTyp('andere|feind').typ, 'feind');
  assert.equal(normalizeRelationTyp('andere|bekannt').original, null);
});

test('mehrere Typen mit Richtung: Richtung offen ⇒ andere', () => {
  assert.equal(normalizeRelationTyp('elternteil|kind').typ, 'andere');
  assert.equal(normalizeRelationTyp('mentor|schuetzling').typ, 'andere');
  assert.equal(normalizeRelationTyp('schuetzling|andere').typ, 'schuetzling');
});

test('Synonyme und Schreibvarianten auf den Listenwert', () => {
  assert.equal(normalizeRelationTyp('vorgesetzte').typ, 'vorgesetzter');
  assert.equal(normalizeRelationTyp('rival').typ, 'rivale');
  assert.equal(normalizeRelationTyp('Freundin').typ, 'freund');
  assert.equal(normalizeRelationTyp('Vater').typ, 'elternteil');
  assert.equal(normalizeRelationTyp('tochter').typ, 'kind');
  assert.equal(normalizeRelationTyp('Schützling').typ, 'schuetzling');
  assert.equal(normalizeRelationTyp('Ex-Partner').typ, 'ex_partner');
  assert.equal(normalizeRelationTyp('vorgesetzte').original, null);
});

test('unbekannter Typ ⇒ andere, Rohwert bleibt als original erhalten', () => {
  assert.deepEqual(normalizeRelationTyp('tante'), { typ: 'andere', original: 'tante' });
  assert.deepEqual(normalizeRelationTyp('großmutter'), { typ: 'andere', original: 'großmutter' });
  assert.deepEqual(normalizeRelationTyp(''), { typ: 'andere', original: null });
  assert.deepEqual(normalizeRelationTyp(undefined), { typ: 'andere', original: null });
});

test('normalizeRelationTypes: in place, Rohwert füllt nur eine leere Beschreibung', () => {
  const list = [
    { figur_id: 'a', typ: 'tante' },
    { figur_id: 'b', typ: 'onkel', beschreibung: 'Ihr Onkel aus Bremen.' },
    { von: 'x', zu: 'y', typ: 'andere|bekannt' },
    { figur_id: 'c', typ: 'freund' },
    null,
  ];
  assert.equal(normalizeRelationTypes(list), 3);
  assert.deepEqual(list[0], { figur_id: 'a', typ: 'andere', beschreibung: 'tante' });
  assert.equal(list[1].beschreibung, 'Ihr Onkel aus Bremen.');
  assert.equal(list[2].typ, 'bekannt');
  assert.equal(list[3].typ, 'freund');
});

test('Graph-Styling deckt genau die Liste ab', async () => {
  const { BZ, BZ_SOZIO_CAT, DIRECTED_TYPES } = await import('../../public/js/graph/constants.js');
  assert.deepEqual(Object.keys(BZ).sort(), [...RELATION_TYPES].sort());
  assert.deepEqual(Object.keys(BZ_SOZIO_CAT).sort(), [...RELATION_TYPES].sort());
  for (const t of DIRECTED_TYPES) assert.ok(RELATION_TYPES.includes(t), t);
});

test('jeder Typ hat ein Label in beiden Locales', () => {
  for (const loc of ['de', 'en']) {
    const json = JSON.parse(read(`public/js/i18n/${loc}.json`));
    for (const t of RELATION_TYPES) assert.ok(`figuren.bz.${t}` in json, `${loc}: figuren.bz.${t} fehlt`);
  }
});

test('Prompts nennen die Liste nur über RELATION_TYPES_PROMPT, nie als Literal', () => {
  const literal = RELATION_TYPES.join('|');
  for (const f of ['public/js/prompts/komplett/schema-strings.js', 'public/js/prompts/komplett/figuren.js']) {
    assert.ok(!read(f).includes(literal), `${f}: Typenliste hartcodiert`);
  }
});
