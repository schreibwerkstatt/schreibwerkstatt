// Rechenschicht Berufsweg/Hobbys (public/js/book/figure-stationen.js):
// «aktiv am Stichtag», Normalisierung (Browser-Formular == Server-Route) und die
// Lebenslauf-Einträge. Dieselbe Rechnung trägt Alterstabelle und `get_figure_age`.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stationAm, stationenAm, normalizeStation, stationZeitraum, stationTitel, stationenAlsEreignisse,
} from '../../public/js/book/figure-stationen.js';

const t = (k, p) => `${k}:${JSON.stringify(p)}`;

test('stationAm: Jahr-Grenzen inklusiv, Monat nur wenn beide Seiten ihn kennen', () => {
  const s = { von_jahr: 1998, von_monat: 5, bis_jahr: 2004, bis_monat: null };
  assert.equal(stationAm(s, { jahr: 1997 }).aktiv, false);
  assert.equal(stationAm(s, { jahr: 1998 }).aktiv, true, 'ohne Stichtag-Monat zählt das ganze Jahr');
  assert.equal(stationAm(s, { jahr: 1998, monat: 4 }).aktiv, false);
  assert.equal(stationAm(s, { jahr: 1998, monat: 5 }).aktiv, true);
  assert.equal(stationAm(s, { jahr: 2004, monat: 12 }).aktiv, true, 'Ende ohne Monat: ganzes Jahr');
  assert.equal(stationAm(s, { jahr: 2005 }).aktiv, false);
});

test('stationAm: offenes Ende läuft weiter, unbekannter Beginn ist unsicher, undatiert ist null', () => {
  assert.deepEqual(stationAm({ von_jahr: 2001 }, { jahr: 2030 }), { aktiv: true, unsicher: false });
  assert.deepEqual(stationAm({ bis_jahr: 2001 }, { jahr: 1990 }), { aktiv: true, unsicher: true });
  assert.equal(stationAm({ bis_jahr: 2001 }, { jahr: 2002 }).aktiv, false);
  assert.equal(stationAm({ taetigkeit: 'Koch' }, { jahr: 2000 }), null);
});

test('stationenAm: Vorschläge zählen nie', () => {
  const list = [
    { id: 1, status: 'aktiv', von_jahr: 1990 },
    { id: 2, status: 'vorschlag', von_jahr: 1990 },
    { id: 3, status: 'aktiv', von_jahr: 2010 },
  ];
  assert.deepEqual(stationenAm(list, { jahr: 2000 }).map(s => s.id), [1]);
});

test('normalizeStation: Pflichtfeld, Jahr-/Monatsgrenzen, Ende nicht vor Beginn, Monat ohne Jahr fällt', () => {
  assert.equal(normalizeStation('berufe', { taetigkeit: '  ' }).fehler, 'taetigkeit');
  assert.equal(normalizeStation('hobbys', {}).fehler, 'hobby');
  assert.equal(normalizeStation('mars', { hobby: 'x' }).fehler, 'kind');
  assert.equal(normalizeStation('berufe', { taetigkeit: 'Koch', art: 'chef' }).fehler, 'art');
  assert.equal(normalizeStation('berufe', { taetigkeit: 'Koch', von_jahr: 12 }).fehler, 'von_jahr');
  assert.equal(normalizeStation('berufe', { taetigkeit: 'Koch', von_jahr: 2000, von_monat: 13 }).fehler, 'von_monat');
  assert.equal(normalizeStation('berufe', { taetigkeit: 'Koch', von_jahr: 2000, bis_jahr: 1999 }).fehler, 'bis_jahr');
  assert.equal(normalizeStation('berufe', { taetigkeit: 'Koch', von_jahr: 2000, von_monat: 6, bis_jahr: 2000, bis_monat: 5 }).fehler, 'bis_jahr');

  const ok = normalizeStation('berufe', { taetigkeit: ' Koch ', von_jahr: '2000', bis_monat: 4, arbeitgeber: '' });
  assert.equal(ok.fehler, undefined);
  assert.equal(ok.fields.taetigkeit, 'Koch');
  assert.equal(ok.fields.art, 'beruf', 'Default-Art');
  assert.equal(ok.fields.von_jahr, 2000);
  assert.equal(ok.fields.bis_monat, null, 'Monat ohne Jahr ist keine Angabe');
  assert.equal(ok.fields.arbeitgeber, null);
  assert.equal('arbeitgeber' in normalizeStation('hobbys', { hobby: 'Schach' }).fields, false);
});

test('stationZeitraum / stationTitel', () => {
  assert.equal(stationZeitraum({ von_jahr: 1998, bis_jahr: 2004 }, t), 'figuren.stationen.zeitraum:{"von":"1998","bis":"2004"}');
  assert.equal(stationZeitraum({ von_jahr: 1998, von_monat: 5 }, t), 'figuren.stationen.seit:{"von":"05.1998"}');
  assert.equal(stationZeitraum({ bis_jahr: 2004 }, t), 'figuren.stationen.bis:{"bis":"2004"}');
  assert.equal(stationZeitraum({}, t), '');
  assert.equal(stationTitel('berufe', { taetigkeit: 'Koch', arbeitgeber: 'Hotel Krone' }), 'Koch (Hotel Krone)');
  assert.equal(stationTitel('hobbys', { hobby: 'Schach' }), 'Schach');
});

test('stationenAlsEreignisse: Beginn und Ende, kein doppeltes Ende im selben Jahr, Vorschläge nicht', () => {
  const evts = stationenAlsEreignisse('berufe', [
    { status: 'aktiv', taetigkeit: 'Koch', von_jahr: 1998, bis_jahr: 2004, page_id: 7 },
    { status: 'aktiv', taetigkeit: 'Aushilfe', von_jahr: 2005, bis_jahr: 2005 },
    { status: 'vorschlag', taetigkeit: 'Pilot', von_jahr: 2010 },
    { status: 'aktiv', taetigkeit: 'undatiert' },
  ]);
  assert.deepEqual(evts.map(e => [e.jahr, e.phase, e.titel]), [
    [1998, 'beginn', 'Koch'], [2004, 'ende', 'Koch'], [2005, 'beginn', 'Aushilfe'],
  ]);
  assert.equal(evts[0].page_id, 7);
  assert.equal(evts[0].station, 'berufe');
});
