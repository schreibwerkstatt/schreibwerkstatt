'use strict';
// Geburts-Event → Geburtsjahr: ein Event «Geburt von X» verknüpft auch Eltern
// und Grosseltern; zugeordnet wird nur, wem die Chronologie es zuweist.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { birthYearsFromEvents } = require('../../lib/figure-years');

test('Geburt eines Kindes macht die Eltern nicht zu Neugeborenen', () => {
  const rows = [
    { fid: 'mutter', y: 1986, subtyp: 'wendepunkt', eid: 1 },
    { fid: 'vater', y: 1986, subtyp: 'wendepunkt', eid: 1 },
    { fid: 'mutter', y: 1988, subtyp: 'geburt', eid: 2 },
    { fid: 'vater', y: 1988, subtyp: 'geburt', eid: 2 },
    { fid: 'kind', y: 1988, subtyp: 'geburt', eid: 2 },
  ];
  const out = birthYearsFromEvents(rows);
  assert.equal(out.get('kind'), 1988);
  assert.equal(out.has('mutter'), false);
  assert.equal(out.has('vater'), false);
});

test('Mehrdeutiges Geburts-Event zählt für niemanden', () => {
  const rows = [
    { fid: 'grossmutter', y: 1988, subtyp: 'geburt', eid: 2 },
    { fid: 'kind', y: 1988, subtyp: 'geburt', eid: 2 },
  ];
  assert.equal(birthYearsFromEvents(rows).size, 0);
});

test('Spätere Geburt eines Geschwisters überschreibt die eigene nicht', () => {
  const rows = [
    { fid: 'manuel', y: 1988, subtyp: 'geburt', eid: 2 },
    { fid: 'manuel', y: 1999, subtyp: 'konflikt', eid: 3 },
    { fid: 'manuel', y: 2000, subtyp: 'geburt', eid: 4 },
    { fid: 'simon', y: 2000, subtyp: 'geburt', eid: 4 },
  ];
  const out = birthYearsFromEvents(rows);
  assert.equal(out.get('manuel'), 1988);
  assert.equal(out.get('simon'), 2000);
});

test('Rohe figure_events ohne eid: jede Zeile ist ihr eigenes Event', () => {
  const rows = [
    { fid: 'a', y: 1970, subtyp: 'geburt' },
    { fid: 'b', y: 1960, subtyp: 'wendepunkt' },
    { fid: 'b', y: 1988, subtyp: 'geburt' },
  ];
  const out = birthYearsFromEvents(rows);
  assert.equal(out.get('a'), 1970);
  assert.equal(out.has('b'), false);
});

test('Mehrere Kandidaten: der Name im Ereignis entscheidet', () => {
  const rows = [
    { fid: 'stefan', fname: 'Stefan', y: 1968, subtyp: 'geburt', eid: 1, ereignis: 'Geburt von Stefan' },
    { fid: 'gisela', fname: 'Gisela', y: 1968, subtyp: 'geburt', eid: 1, ereignis: 'Geburt von Stefan' },
    { fid: 'andrea', fname: 'Andrea', y: 1962, subtyp: 'geburt', eid: 2, ereignis: 'Geburt von Andrea' },
    { fid: 'andrea', fname: 'Andrea', y: 1986, subtyp: 'geburt', eid: 3, ereignis: 'Geburt von Samuel' },
    { fid: 'samuel', fname: 'Samuel', y: 1986, subtyp: 'geburt', eid: 3, ereignis: 'Geburt von Samuel' },
  ];
  const out = birthYearsFromEvents(rows);
  assert.equal(out.get('stefan'), 1968);
  assert.equal(out.has('gisela'), false);
  assert.equal(out.get('andrea'), 1962);
  assert.equal(out.get('samuel'), 1986);
});
