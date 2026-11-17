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
  assert.deepEqual(cov.months['2024-03'].rueckblick, { id: 7, created_at: 'X', stale: false });
  assert.deepEqual(cov.years['2024'].rueckblick, { id: 9, created_at: 'Y', stale: false });
});

test('buildRueckblickCoverage: verwaister Rückblick erweitert die Jahr-Range', () => {
  const pages = [{ page_name: '2024-03-01' }];
  const rbRows = [{ zeitraum: '2020-06', id: 1, created_at: 'Z' }];
  const cov = buildRueckblickCoverage(pages, rbRows);
  assert.equal(cov.minYear, 2020);
  assert.equal(cov.maxYear, 2024);
  assert.equal(cov.months['2020-06'].entries, 0);
  assert.deepEqual(cov.months['2020-06'].rueckblick, { id: 1, created_at: 'Z', stale: false }, 'verwaist ist nicht veraltet');
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
  assert.deepEqual(result.orte, [{ name: 'Zürich', aliase: [], haeufigkeit: 1, belege: ['2024-03-12'] }]);
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

test('buildRueckblickCoverage: stale = Eintrag nach dem letzten Stand geändert oder Anzahl abweichend', () => {
  const pages = [
    { page_id: 1, page_name: '2024-03-01', updated_at: '2024-04-05T00:00:00Z' },
    { page_id: 2, page_name: '2024-03-02', updated_at: '2024-03-02T00:00:00Z' },
  ];
  const at = (row) => buildRueckblickCoverage(pages, [{ zeitraum: '2024-03', id: 1, ...row }]).months['2024-03'].rueckblick.stale;
  assert.equal(at({ created_at: '2024-04-01T00:00:00Z', entry_count: 2 }), true, 'Eintrag nach Erstellung bearbeitet');
  assert.equal(at({ created_at: '2024-04-01T00:00:00Z', checked_at: '2024-04-06T00:00:00Z', entry_count: 2 }), false,
    'ein späterer Lauf hat den Rückblick als unverändert bestätigt');
  assert.equal(at({ created_at: '2024-04-10T00:00:00Z', entry_count: 3 }), true, 'Eintrag gelöscht');
  assert.equal(at({ created_at: '2024-04-10T00:00:00Z', entry_count: 2 }), false);
  assert.equal(at({ created_at: '2024-04-10T00:00:00Z', entry_count: null }), false, 'Altzeile ohne Snapshot');
});

test('verifyRueckblickBelege: Klammer-Zusatz und Schrägstrich → Name + Aliase, Varianten verschmelzen', () => {
  const r = {
    themen: [],
    personen: [
      { name: 'Charlotte (Charlotti)', belege: ['2024-03-04'] },
      { name: 'Olivia', aliase: ['Oli'], belege: ['2024-03-12'] },
      { name: 'Oli', belege: ['2024-03-04'] },
    ],
    orte: [{ name: 'Basel / Basel-Stadt', belege: ['2024-03-12'] }],
    zusammenfassung: 'x',
  };
  const { result } = verifyRueckblickBelege(r, ['2024-03-04', '2024-03-12']);
  assert.deepEqual(result.personen.map(p => [p.name, p.aliase, p.belege]), [
    ['Olivia', ['Oli'], ['2024-03-04', '2024-03-12']],
    ['Charlotte', [], ['2024-03-04']],
  ]);
  assert.equal(result.personen[1].zusatz, 'Charlotti', 'Zusatz bleibt Anzeige, wird nicht gesucht');
  assert.deepEqual(result.orte.map(o => [o.name, o.aliase]), [['Basel', ['Basel-Stadt']]]);
});

test('verifyRueckblickBelege: Textsuche ergänzt Personen-/Orts-Belege (Vereinigung), Themen nicht', () => {
  const entries = [
    { datum: '2024-03-01', text: 'Mit Anna im Café.' },
    { datum: '2024-03-02', text: 'Annas Geburtstag, danach Bern.' },
    { datum: '2024-03-03', text: 'Allein, ganz frank und frei.' },
    { datum: '2024-03-04', text: 'Sie rief an.' },
  ];
  const r = {
    themen: [{ label: 'Anna', belege: ['2024-03-01'] }],
    personen: [
      { name: 'Anna', aliase: [], belege: ['2024-03-04'] }, // Modell: Pronomen-Tag bleibt
      { name: 'Frank', aliase: [], belege: ['2024-03-02'] },
    ],
    orte: [{ name: 'Bern', aliase: [], belege: [] }],
    zusammenfassung: 'x',
  };
  const { result } = verifyRueckblickBelege(r, entries);
  const by = Object.fromEntries(result.personen.map(p => [p.name, p.belege]));
  assert.deepEqual(by.Anna, ['2024-03-01', '2024-03-02', '2024-03-04'], 'Genitiv-s trifft, Modell-Beleg bleibt');
  assert.deepEqual(by.Frank, ['2024-03-02'], 'kleingeschriebenes «frank» trifft den Namen nicht');
  assert.deepEqual(result.orte[0].belege, ['2024-03-02'], 'Ort ohne Modell-Beleg über die Textsuche');
  assert.equal(result.orte[0].haeufigkeit, 1);
  assert.deepEqual(result.themen[0].belege, ['2024-03-01'], 'Themen: keine Textsuche');
});

test('verifyRueckblickBelege: Themen gedeckelt auf THEMEN_MAX (häufigste bleiben)', () => {
  const { THEMEN_MAX } = require('../../routes/jobs/rueckblick-facets');
  const themen = Array.from({ length: THEMEN_MAX + 3 }, (_, i) => ({
    label: `T${i}`, belege: i < 3 ? ['2024-03-01', '2024-03-02'] : ['2024-03-01'],
  }));
  const { result } = verifyRueckblickBelege({ themen, zusammenfassung: 'x' }, ['2024-03-01', '2024-03-02']);
  assert.equal(result.themen.length, THEMEN_MAX);
  assert.deepEqual(result.themen.slice(0, 3).map(t => t.label), ['T0', 'T1', 'T2']);
});

test('verifyRueckblickBelege: idempotent auch mit Textsuche und Aliasen', () => {
  const entries = [{ datum: '2024-03-01', text: 'Anna und Oli in Basel.' }, { datum: '2024-03-02', text: 'Olivia schreibt.' }];
  const r = { personen: [{ name: 'Olivia (Freundin)', aliase: ['Oli'], belege: ['2024-03-02'] }], orte: [{ name: 'Basel', belege: [] }], zusammenfassung: 'x' };
  const once = verifyRueckblickBelege(r, entries).result;
  const twice = verifyRueckblickBelege(once, entries);
  assert.deepEqual(twice.result, once);
  assert.equal(twice.dropped, 0);
  assert.deepEqual(once.personen[0].belege, ['2024-03-01', '2024-03-02']);
});
