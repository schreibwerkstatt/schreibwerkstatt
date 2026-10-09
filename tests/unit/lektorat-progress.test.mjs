import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { lektoratProgress } = require('../../lib/lektorat-progress.js');

const F = (typ, original, korrektur = '') => ({ typ, original, korrektur, erklaerung: '' });
const prevRow = (fehler, applied = null) => ({
  checked_at: '2026-10-01T10:00:00.000Z',
  errors_json: JSON.stringify(fehler),
  applied_errors_json: applied ? JSON.stringify(applied) : null,
});

test('ohne Vorlauf → null', () => {
  assert.equal(lektoratProgress(null, [F('stil', 'x')], 'x'), null);
});

test('behoben entscheidet der Text, nicht das Modell', () => {
  const prev = prevRow([F('grammatik', 'der Hund bellen'), F('stil', 'sehr sehr schön')]);
  // „der Hund bellen" ist umgeschrieben, „sehr sehr schön" steht noch da und
  // wird diesmal nicht gemeldet → Streuung, nicht behoben.
  const p = lektoratProgress(prev, [], 'Der Hund bellt. Es war sehr sehr schön.');
  assert.equal(p.fixed, 1);
  assert.equal(p.notReported, 1);
  assert.equal(p.remaining, 0);
  assert.equal(p.added, 0);
  assert.deepEqual(p.fixedItems.map(f => f.original), ['der Hund bellen']);
});

test('geblieben und neu, Abgleich als Multimenge mit normalisiertem Whitespace', () => {
  const prev = prevRow([F('fuellwort', 'eigentlich'), F('fuellwort', 'eigentlich')]);
  const now = [F('fuellwort', 'eigentlich'), F('fuellwort', 'eigentlich'), F('fuellwort', 'eigentlich'), F('grammatik', 'zwei\n\nZeilen')];
  const p = lektoratProgress(prev, now, 'eigentlich eigentlich eigentlich zwei Zeilen');
  assert.equal(p.remaining, 2);
  assert.equal(p.added, 2);
  assert.equal(p.fixed, 0);
});

test('per Übernahme behoben wird mitgezählt', () => {
  const prev = prevRow([F('rechtschreibung', 'Fehlr'), F('stil', 'umgeschrieben')], [F('rechtschreibung', 'Fehlr', 'Fehler')]);
  const p = lektoratProgress(prev, [], 'Ein Fehler, sauber.');
  assert.equal(p.fixed, 2);
  assert.equal(p.viaApply, 1);
});

test('Typ-Delta: nur Typen mit Veränderung, Verbesserung zuerst', () => {
  const prev = prevRow([F('grammatik', 'a'), F('grammatik', 'b'), F('stil', 'c')]);
  const now = [F('stil', 'c'), F('wiederholung', 'd')];
  const p = lektoratProgress(prev, now, 'c d');
  assert.deepEqual(p.byType, [{ typ: 'grammatik', delta: -2 }, { typ: 'wiederholung', delta: 1 }]);
  assert.equal(p.prevCount, 3);
  assert.equal(p.count, 2);
});

test('Befunde ohne original: aktuell neu, im Vorlauf übergangen; korrupte Zeile kippt nichts', () => {
  const p = lektoratProgress(prevRow([F('stil', '')]), [F('stil', '')], 'text');
  assert.equal(p.added, 1);
  assert.equal(p.fixed, 0);
  assert.equal(p.notReported, 0);
  const q = lektoratProgress({ checked_at: null, errors_json: '{kaputt', applied_errors_json: 'x' }, [F('stil', 'a')], 'a');
  assert.equal(q.prevCount, 0);
  assert.equal(q.added, 1);
});
