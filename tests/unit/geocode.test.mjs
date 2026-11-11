// Geocode-Proxy: Nominatim-Antwort (Fremd-Input) → flaches Kandidaten-Array.
// Verwirft Eintraege ohne gueltige Koordinaten, parst Strings zu Number.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseNominatimResults, parsePhotonResults } = require('../../routes/geocode.js');
const { geocode, parseToponym, onlyCountry, splitAnchor, inTown } = require('../../lib/geocode.js');

test('geocode: leere Query → leeres Array (kein Netzwerk-Call)', async () => {
  assert.deepEqual(await geocode(''), []);
  assert.deepEqual(await geocode('   '), []);
  assert.deepEqual(await geocode(null), []);
});

test('geocode: zu lange Query → leeres Array (kein Netzwerk-Call)', async () => {
  assert.deepEqual(await geocode('x'.repeat(201)), []);
});

test('parseToponym: schneidet Beschreibungsteil vor lokativem Bindewort ab', () => {
  assert.equal(parseToponym('Bar in Olten'), 'Olten');
  assert.equal(parseToponym('Kleines Café am Bahnhof Bern'), 'Bahnhof Bern');
  assert.equal(parseToponym('Hotel zur Post Luzern'), 'Post Luzern');
  assert.equal(parseToponym('Pub on Baker Street'), 'Baker Street');
});

test('parseToponym: letztes Bindewort gewinnt (mehrere)', () => {
  assert.equal(parseToponym('Wohnung in der Altstadt in Zürich'), 'Zürich');
});

test('parseToponym: kein Bindewort oder leerer Rest → null', () => {
  assert.equal(parseToponym('Olten'), null);
  assert.equal(parseToponym('Marktplatz von Bern'), null); // «von» nicht in der Liste → KI-Fallback
  assert.equal(parseToponym('Bar in '), null);
  assert.equal(parseToponym(''), null);
  assert.equal(parseToponym(null), null);
});

test('parseNominatimResults: mappt lat/lon-Strings zu Number + displayName', () => {
  const out = parseNominatimResults([
    { lat: '47.3769', lon: '8.5417', display_name: 'Zürich, Schweiz' },
  ]);
  assert.deepEqual(out, [{ lat: 47.3769, lng: 8.5417, displayName: 'Zürich, Schweiz' }]);
});

test('parseNominatimResults: verwirft Eintraege ohne gueltige Koordinaten', () => {
  const out = parseNominatimResults([
    { lat: 'abc', lon: '8.5', display_name: 'kaputt' },
    { lat: '1.0', lon: null, display_name: 'kaputt2' },
    { lat: '46.9', lon: '7.4', display_name: 'Bern' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].displayName, 'Bern');
});

test('parseNominatimResults: Nicht-Array → leeres Array', () => {
  assert.deepEqual(parseNominatimResults(null), []);
  assert.deepEqual(parseNominatimResults({}), []);
  assert.deepEqual(parseNominatimResults('x'), []);
});

test('parseNominatimResults: fehlender display_name → leerer String', () => {
  const out = parseNominatimResults([{ lat: '1', lon: '2' }]);
  assert.equal(out[0].displayName, '');
});

test('parsePhotonResults: [lon,lat]-Reihenfolge → {lat,lng} + zusammengesetzter displayName + countrycode', () => {
  const out = parsePhotonResults({
    type: 'FeatureCollection',
    features: [
      { geometry: { type: 'Point', coordinates: [8.5417, 47.3769] },
        properties: { name: 'Zürich', state: 'Zürich', country: 'Schweiz', countrycode: 'CH' } },
    ],
  });
  assert.deepEqual(out, [{ lat: 47.3769, lng: 8.5417, displayName: 'Zürich, Zürich, Schweiz', countrycode: 'ch', area: 'Zürich' }]);
  // county (Bezirk) bleibt aus area draussen — er heisst oft wie sein Hauptort.
  const [h] = parsePhotonResults({ features: [{ geometry: { coordinates: [7.87, 47.38] },
    properties: { name: 'Hauptstrasse', city: 'Hauenstein-Ifenthal', county: 'Amtei Olten-Gösgen' } }] });
  assert.equal(inTown(h, 'olten'), false);
});

test('onlyCountry: nur Treffer im Zielland, sonst leer (kein Fehltreffer im Nachbarland)', () => {
  const cands = [
    { displayName: 'Olten, DE', countrycode: 'de' },
    { displayName: 'Olten, CH', countrycode: 'ch' },
  ];
  assert.deepEqual(onlyCountry(cands, 'ch'), [{ displayName: 'Olten, CH', countrycode: 'ch' }]);
  // Index ohne das Zielland (Photon mit Europa-Ausschnitt, «Boston» → England):
  // lieber unverortet als falsch verortet.
  assert.deepEqual(onlyCountry(cands, 'us'), []);
  assert.deepEqual(onlyCountry(cands, null), cands);
});

test('splitAnchor: Gemeinde nach dem ersten Komma, erstes Wort gefaltet', () => {
  assert.deepEqual(splitAnchor('Hammerstrasse, Olten'), { town: 'olten', rest: 'Olten' });
  assert.deepEqual(splitAnchor('Fröschenlochstrasse, Rickenbach bei Olten'),
    { town: 'rickenbach', rest: 'Rickenbach bei Olten' });
  assert.deepEqual(splitAnchor('Schöngrund, Zürich'), { town: 'zurich', rest: 'Zürich' });
  assert.equal(splitAnchor('Olten'), null);
  assert.equal(splitAnchor('Bahnhof, '), null);
});

test('inTown: Photon-area bzw. Nominatim-displayName enthaelt die Gemeinde', () => {
  assert.equal(inTown({ area: 'Hauptstrasse, Eppenberg, Wöschnau' }, 'eppenberg'), true);
  assert.equal(inTown({ area: 'Schafmatt, Oltingen' }, 'olten'), false);
  assert.equal(inTown({ area: 'Hambergstraße, Lohne (Oldenburg)' }, 'olten'), false);
  assert.equal(inTown({ area: 'Fröschenlochstrasse, Rickenbach SO' }, 'rickenbach'), true);
  assert.equal(inTown({ displayName: 'Hammerallee, Olten, Solothurn, Schweiz' }, 'olten'), true);
});

test('parsePhotonResults: verwirft Features ohne gueltige Koordinaten', () => {
  const out = parsePhotonResults({
    features: [
      { geometry: { coordinates: ['x', 47] }, properties: { name: 'kaputt' } },
      { geometry: { coordinates: [7.4] }, properties: { name: 'kaputt2' } },
      { properties: { name: 'ohne geometry' } },
      { geometry: { coordinates: [7.4474, 46.948], type: 'Point' }, properties: { name: 'Bern' } },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].displayName, 'Bern');
});

test('parsePhotonResults: keine FeatureCollection → leeres Array', () => {
  assert.deepEqual(parsePhotonResults(null), []);
  assert.deepEqual(parsePhotonResults({}), []);
  assert.deepEqual(parsePhotonResults({ features: 'x' }), []);
});
