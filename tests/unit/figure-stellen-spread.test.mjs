// Stellen-Auswahl für Schulweg- und Berufsweg-/Hobby-Vorschlag
// (routes/jobs/shared/figure-stellen.js): spread/pickStellen dürfen nie
// undefined-Einträge liefern — auch nicht, wenn nur noch ein Platz frei ist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { spread, pickStellen } = require('../../routes/jobs/shared/figure-stellen.js');

test('spread: max 1 und 0 liefern keine Lücken', () => {
  assert.deepEqual(spread(['a', 'b', 'c'], 1), ['a']);
  assert.deepEqual(spread(['a', 'b', 'c'], 0), []);
  assert.deepEqual(spread(['a', 'b', 'c', 'd', 'e'], 2), ['a', 'e']);
});

test('pickStellen: Auffüllen mit genau einem freien Platz', () => {
  const s = (satz) => ({ satz, page_id: 1 });
  const list = [s('Er war Bäcker.'), s('Er arbeitete.'), s('Er arbeitete wieder.'), s('Er arbeitete noch.')];
  // eine starke Stelle, max 2 → spread(schwach, 1)
  const picked = pickStellen(list, 2, /bäcker/i);
  assert.equal(picked.length, 2);
  assert.ok(picked.every(Boolean));
  assert.equal(picked[0].satz, 'Er war Bäcker.');
});
