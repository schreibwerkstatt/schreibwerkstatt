'use strict';
// Facetten des Tagebuch-Rückblicks (routes/jobs/rueckblick-facets.js): Namen
// normalisieren, Varianten zusammenführen, Textsuche, Map-Reduce-Merge und der
// Verlauf über die Monate. Pure — kein DB-Bootstrap.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  splitName, mergeNennungen, findTermDays, mergeRueckblickFacets, buildRueckblickVerlauf,
} = require('../../routes/jobs/rueckblick-facets');

test('splitName: Klammer-Zusatz und Schrägstrich', () => {
  assert.deepEqual(splitName('Charlotte (Charlotti)'), { name: 'Charlotte', slashAliase: [], zusatz: 'Charlotti' });
  assert.deepEqual(splitName('Basel / Basel-Stadt'), { name: 'Basel', slashAliase: ['Basel-Stadt'], zusatz: '' });
  assert.deepEqual(splitName('  Anna '), { name: 'Anna', slashAliase: [], zusatz: '' });
  assert.deepEqual(splitName('(nur Klammer)'), { name: '(nur Klammer)', slashAliase: [], zusatz: '' }, 'ohne Name davor bleibt es stehen');
});

test('mergeNennungen: gemeinsamer Name/Alias verschmilzt — auch über Ketten', () => {
  const out = mergeNennungen([
    { name: 'Anna', aliase: ['Anni'], belege: ['a'] },
    { name: 'Bernd', belege: ['b'] },
    { name: 'Anna-Lena', aliase: ['Anni', 'Lena'], belege: ['c'] },
    { name: 'lena', belege: ['d'] },
  ], 'name');
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Anna', 'Name des ersten Treffers bleibt kanonisch');
  assert.deepEqual(out[0].aliase.sort(), ['Anna-Lena', 'Anni', 'Lena']);
  assert.deepEqual(out[0].belege.sort(), ['a', 'c', 'd']);
});

test('mergeNennungen: Themen nur bei gleichem Label (case-insensitiv), ohne aliase-Feld', () => {
  const out = mergeNennungen([{ label: 'Arbeit', belege: ['a'] }, { label: 'arbeit', belege: ['b'] }, { label: 'Liebe', belege: ['c'] }], 'label');
  assert.deepEqual(out.map(t => [t.label, t.belege]), [['Arbeit', ['a', 'b']], ['Liebe', ['c']]]);
  assert.equal('aliase' in out[0], false);
});

test('findTermDays: ganzes Wort, Genitiv, Grossschreibung, Mindestlänge', () => {
  const entries = [
    { datum: 'd1', text: 'Annas Tag.' },
    { datum: 'd2', text: 'Hannah kam.' },
    { datum: 'd3', text: 'Jo und Bo.' },
    { datum: 'd4', text: 'anna klein.' },
  ];
  assert.deepEqual([...findTermDays(['Anna'], entries)], ['d1']);
  assert.deepEqual([...findTermDays(['Jo'], entries)], [], 'unter der Mindestlänge wird nicht gesucht');
  assert.deepEqual([...findTermDays(['Hannah', 'Anna'], entries)].sort(), ['d1', 'd2']);
});

test('mergeRueckblickFacets: Belege-Union, Aliase verbinden Teile, haeufigkeit = eindeutige Tage', () => {
  const parts = [
    { monat: '2024-01', themen: [{ label: 'Arbeit', belege: ['2024-01-03'] }], personen: [{ name: 'Anna', aliase: ['Anni'], belege: ['2024-01-05'] }], orte: [] },
    { monat: '2024-02', themen: [{ label: 'arbeit', belege: ['2024-01-03', '2024-02-08'] }], personen: [{ name: 'Anni', belege: ['2024-02-09'] }], orte: [] },
  ];
  const m = mergeRueckblickFacets(parts);
  assert.equal(m.themen.length, 1);
  assert.equal(m.themen[0].haeufigkeit, 2);
  assert.deepEqual(m.themen[0].belege, ['2024-01-03', '2024-02-08']);
  assert.equal(m.personen.length, 1);
  assert.equal(m.personen[0].name, 'Anna');
  assert.equal(m.personen[0].haeufigkeit, 2);
});

test('buildRueckblickVerlauf: Monate chronologisch, Belegtage je Monat, Aliase verbinden, Name des jüngsten Monats', () => {
  const rows = [
    { id: 2, zeitraum: '2024-02', entry_count: 10, result: {
      themen: [{ label: 'Arbeit', belege: ['2024-02-01'] }],
      personen: [{ name: 'Oli', belege: ['2024-02-01', '2024-02-03'] }],
      orte: [],
    } },
    { id: 1, zeitraum: '2024-01', entry_count: 5, result: {
      themen: [{ label: 'Arbeit', belege: ['2024-01-02'] }, { label: 'Umzug', belege: ['2024-01-03'] }],
      personen: [{ name: 'Olivia', aliase: ['Oli'], belege: ['2024-01-02'] }, { name: 'Bernd', belege: ['2024-01-04'] }],
      orte: [{ name: 'Basel', belege: ['2024-01-02'] }],
    } },
    { id: 3, zeitraum: '2024', entry_count: 15, result: { personen: [{ name: 'X', belege: ['2024-01-01'] }] } }, // Jahr: ignoriert
    { id: 4, zeitraum: '2024-03', entry_count: 3, result: null }, // kaputt: ignoriert
  ];
  const v = buildRueckblickVerlauf(rows);
  assert.deepEqual(v.months, [{ zeitraum: '2024-01', id: 1, entries: 5 }, { zeitraum: '2024-02', id: 2, entries: 10 }]);
  assert.deepEqual(v.personen.map(p => [p.name, p.perMonth, p.total, p.months]), [
    ['Oli', { '2024-01': 1, '2024-02': 2 }, 3, 2],
    ['Bernd', { '2024-01': 1 }, 1, 1],
  ]);
  assert.deepEqual(v.personen[0].aliase, ['Olivia'], 'ältere Schreibweise wird Alias');
  assert.deepEqual(v.themen.map(t => [t.name, t.months]), [['Arbeit', 2], ['Umzug', 1]]);
  assert.equal('aliase' in v.themen[0], false);
  assert.deepEqual(v.orte.map(o => o.name), ['Basel']);
});
