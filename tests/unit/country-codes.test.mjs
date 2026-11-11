// country-codes.js: jedes wählbare Schauplatz-Land hat eine Startansicht der
// Geo-Karte (sonst fiele ein Buch ohne verorteten Ort auf die Weltansicht zurück).
import test from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRY_CODES, countryView } from '../../public/js/country-codes.js';

test('countryView: deckt alle COUNTRY_CODES ab, mit plausiblen Werten', () => {
  for (const cc of COUNTRY_CODES) {
    const v = countryView(cc);
    assert.ok(v, `Startansicht fehlt: ${cc}`);
    assert.ok(Math.abs(v.center[0]) <= 90 && Math.abs(v.center[1]) <= 180, cc);
    assert.ok(v.zoom >= 2 && v.zoom <= 13, cc);
  }
});

test('countryView: Gross-/Kleinschreibung egal, Unbekanntes → null', () => {
  assert.deepEqual(countryView('CH'), countryView('ch'));
  assert.equal(countryView('xx'), null);
  assert.equal(countryView(null), null);
});
