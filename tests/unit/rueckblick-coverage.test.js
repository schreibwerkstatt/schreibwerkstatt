'use strict';
// Server-Bucketing der Rückblick-Heatmap-Coverage (routes/jobs/rueckblick-dates.js
// #buildRueckblickCoverage). Pure Funktion — kein DB-Bootstrap nötig. Reuse von
// entryDate gegen gemischte Page-Namen, Jahr- vs. Monats-Rückblick-Match.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRueckblickCoverage, previousZeitraum, verifyRueckblickBelege } = require('../../routes/jobs/rueckblick-dates');

test('previousZeitraum: Monat → Vor-Monat, Jahres-Übergang, Jahr → Vorjahr', () => {
  assert.equal(previousZeitraum('2024-03'), '2024-02');
  assert.equal(previousZeitraum('2024-01'), '2023-12');
  assert.equal(previousZeitraum('2024'), '2023');
  assert.equal(previousZeitraum('garbage'), null);
  assert.equal(previousZeitraum('2024-13'), null);
});

test('buildRueckblickCoverage: datierte Einträge → Monats-/Jahres-Buckets', () => {
  const pages = [
    { page_name: '2024-03-01' },
    { page_name: '2024-03-15' },
    { page_name: '2024-05-02' },
    { page_name: 'Vorwort' }, // undatiert → ignoriert
  ];
  const cov = buildRueckblickCoverage(pages, []);
  assert.equal(cov.months['2024-03'].entries, 2);
  assert.equal(cov.months['2024-05'].entries, 1);
  assert.equal(cov.years['2024'].entries, 3);
  assert.equal(cov.minYear, 2024);
  assert.equal(cov.maxYear, 2024);
  assert.equal(cov.months['2024-03'].rueckblick, null);
});

test('buildRueckblickCoverage: Jahres- vs. Monats-Rückblick-Match', () => {
  const pages = [{ page_name: '2024-03-01' }];
  const rbRows = [
    { zeitraum: '2024-03', id: 7, created_at: 'X' },
    { zeitraum: '2024', id: 9, created_at: 'Y' },
  ];
  const cov = buildRueckblickCoverage(pages, rbRows);
  assert.deepEqual(cov.months['2024-03'].rueckblick, { id: 7, created_at: 'X' });
  assert.deepEqual(cov.years['2024'].rueckblick, { id: 9, created_at: 'Y' });
});

test('buildRueckblickCoverage: verwaister Rückblick erweitert die Jahr-Range', () => {
  const pages = [{ page_name: '2024-03-01' }];
  const rbRows = [{ zeitraum: '2020-06', id: 1, created_at: 'Z' }];
  const cov = buildRueckblickCoverage(pages, rbRows);
  assert.equal(cov.minYear, 2020);
  assert.equal(cov.maxYear, 2024);
  assert.equal(cov.months['2020-06'].entries, 0);
  assert.deepEqual(cov.months['2020-06'].rueckblick, { id: 1, created_at: 'Z' });
});

test('buildRueckblickCoverage: leer', () => {
  assert.deepEqual(buildRueckblickCoverage([], []), { months: {}, years: {}, days: {}, minYear: null, maxYear: null });
});

test('buildRueckblickCoverage: newest je Bucket + Tag → erste Seite des Tages', () => {
  const pages = [
    { page_id: 9, page_name: '2024-03-01', updated_at: '2024-03-05T10:00:00Z' },
    { page_id: 3, page_name: '2024-03-01', updated_at: '2024-03-02T10:00:00Z' },
    { page_id: 4, page_name: '2024-03-20', updated_at: '2024-04-01T00:00:00Z' },
    { page_id: 5, page_name: '2024-07' }, // Monat ohne Tag → kein days-Eintrag
  ];
  const cov = buildRueckblickCoverage(pages, []);
  assert.equal(cov.months['2024-03'].entries, 3);
  assert.equal(cov.months['2024-03'].newest, Date.parse('2024-04-01T00:00:00Z'));
  assert.equal(cov.years['2024'].newest, Date.parse('2024-04-01T00:00:00Z'));
  assert.equal(cov.days['2024-03-01'], 3, 'kleinste page_id gewinnt');
  assert.equal(cov.days['2024-03-20'], 4);
  assert.equal(cov.days['2024-07'], undefined);
});

test('verifyRueckblickBelege: unbekannte Daten fallen, haeufigkeit = verbliebene Belege', () => {
  const r = {
    themen: [
      { label: 'Arbeit', haeufigkeit: 9, belege: ['2024-03-04', '2024-03-31', '2024-03-04'] },
      { label: 'Erfunden', haeufigkeit: 2, belege: ['1999-01-01'] },
    ],
    personen: [{ name: 'Anna', haeufigkeit: 3 }], // ohne Belege → entfällt
    orte: [{ name: ' Zürich ', belege: ['2024-03-12 (Dienstag)'] }],
    bemerkenswerteTage: [
      { datum: '2024-03-12', begruendung: 'b' },
      { datum: '2024-02-30', begruendung: 'erfunden' },
      { datum: '2024-03-04', begruendung: 'a' },
      { datum: '2024-03-04', begruendung: 'doppelt' },
    ],
    zusammenfassung: 'Text',
  };
  const { result, dropped } = verifyRueckblickBelege(r, ['2024-03-04', '2024-03-12']);
  assert.deepEqual(result.themen, [{ label: 'Arbeit', haeufigkeit: 1, belege: ['2024-03-04'] }]);
  assert.deepEqual(result.personen, []);
  assert.deepEqual(result.orte, [{ name: 'Zürich', haeufigkeit: 1, belege: ['2024-03-12'] }]);
  assert.deepEqual(result.bemerkenswerteTage.map(t => t.datum), ['2024-03-04', '2024-03-12'], 'chronologisch, ohne Dubletten/Erfundenes');
  assert.equal(result.zusammenfassung, 'Text');
  assert.ok(dropped >= 5);
});

test('verifyRueckblickBelege: idempotent', () => {
  const dates = ['2024-03-04'];
  const once = verifyRueckblickBelege({ themen: [{ label: 'A', belege: ['2024-03-04'] }], zusammenfassung: 'x' }, dates).result;
  const twice = verifyRueckblickBelege(once, dates);
  assert.deepEqual(twice.result, once);
  assert.equal(twice.dropped, 0);
});
