// Zeitvorschlag aus dem Text (lib/plot-zeit-vorschlag.js) und die Altersspanne
// im Aktnamen (lib/plot-act-age.js) — pure Rechnung.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeZeitVorschlaege } = require('../../lib/plot-zeit-vorschlag.js');
const { parseActAgeRange } = require('../../lib/plot-act-age.js');
const { timeKeyOf } = require('../../lib/time-key.js');

test('parseActAgeRange: Klammer mit zwei plausiblen Altern', () => {
  assert.deepEqual(parseActAgeRange('Erste Krise (28-32)'), { von: 28, bis: 32 });
  assert.deepEqual(parseActAgeRange('Erwachsen (24–28)'), { von: 24, bis: 28 });
  assert.deepEqual(parseActAgeRange('Frühe Jugend ( 14 - 16 )'), { von: 14, bis: 16 });
  assert.equal(parseActAgeRange('Amoklauf-Akt'), null);
  assert.equal(parseActAgeRange('Akt 2'), null);
  assert.equal(parseActAgeRange('Rückwärts (32-28)'), null, 'absteigend');
  assert.equal(parseActAgeRange('Epoche (1900-1950)'), null, 'Jahreszahlen sind kein Alter');
  assert.equal(parseActAgeRange('Weit (0-80)'), null, 'breiter als 30 Jahre');
});

const ev = (o) => ({
  datum: '', datum_label: null, datum_year: null, datum_month: null, datum_day: null,
  datum_ende_year: null, datum_ende_month: null, datum_ende_day: null, story_tag: null,
  datum_unsicher: 0, ereignis: 'E', typ: 'persoenlich', subtyp: 'sonstiges', sort_order: 0, ...o,
});
const TOP = new Map([[1, { page_id: 10, page_name: 'Das nächste Drama' }]]);
const run = (events, { beat = {}, lang = 'de' } = {}) => computeZeitVorschlaege({
  beats: [{ id: 1, status: 'im_buch', zeit: null, verworfen: 0, ...beat }],
  topPage: TOP, eventsByPage: new Map([[10, events]]), lang,
});

test('Vorschlag aus den Ereignissen der besten Fundstelle, mit Belegen', () => {
  const [v] = run([
    ev({ datum: 'Mai 1999', datum_year: 1999, datum_month: 5, ereignis: 'Renate ist schwanger', sort_order: 2 }),
    ev({ datum: 'März 1999', datum_year: 1999, datum_month: 3, ereignis: 'Der Streit', sort_order: 1 }),
  ]);
  assert.equal(v.zeit, 'März–Mai 1999');
  assert.equal(v.page_id, 10);
  assert.equal(v.eindeutig, true);
  assert.deepEqual(v.belege.map(b => b.ereignis), ['Der Streit', 'Renate ist schwanger'], 'erzählte Reihenfolge');
});

test('jede Form liest der Parser als dasselbe Fenster zurück', () => {
  const cases = [
    [[ev({ datum_year: 1987, datum_month: 3, datum_day: 12 })], 'de', '12.03.1987', 'day'],
    [[ev({ datum_year: 1987, datum_month: 3, datum_day: 12 })], 'en', '12 March 1987', 'day'],
    [[ev({ datum_year: 1987, datum_month: 3 })], 'de', 'März 1987', 'month'],
    [[ev({ datum_year: 1987, datum_month: 3 })], 'fr', '1987-03', 'month'],
    [[ev({ datum_year: 1987 })], 'de', '1987', 'year'],
    [[ev({ datum_year: 1987 }), ev({ datum_year: 1989 })], 'de', '1987–1989', 'range'],
    [[ev({ story_tag: 3 }), ev({ story_tag: 5 })], 'de', 'Tag 3–5', 'range'],
  ];
  for (const [events, lang, zeit, precision] of cases) {
    const [v] = run(events, { lang });
    assert.equal(v.zeit, zeit);
    assert.equal(timeKeyOf(v.zeit)?.precision, precision, zeit);
  }
});

test('nur Beats im Buch, ohne Zeit, nicht verworfen', () => {
  const e = [ev({ datum_year: 1999 })];
  assert.deepEqual(run(e, { beat: { status: 'geplant' } }), [], 'geplant steht noch nicht im Text');
  assert.deepEqual(run(e, { beat: { zeit: '1998' } }), [], 'vorhandene Angabe gehört dem Autor');
  assert.deepEqual(run(e, { beat: { verworfen: 1 } }), []);
});

test('Geburten und unsichere Daten zählen nicht, Welt-Ereignisse nur ohne persönliche', () => {
  assert.deepEqual(run([ev({ datum_year: 1968, subtyp: 'geburt' })]), []);
  assert.deepEqual(run([ev({ datum_year: 1999, datum_unsicher: 1 })]), []);
  const [v] = run([ev({ datum_year: 1989, typ: 'extern' }), ev({ datum_year: 1999 })]);
  assert.equal(v.zeit, '1999');
  const [w] = run([ev({ datum_year: 1989, typ: 'extern' })]);
  assert.equal(w.zeit, '1989');
});

test('breite Streuung ist nicht eindeutig', () => {
  const [v] = run([ev({ datum_year: 1980 }), ev({ datum_year: 1999 })]);
  assert.equal(v.zeit, '1980–1999');
  assert.equal(v.spread, 19);
  assert.equal(v.eindeutig, false);
});

// Prod-Fall: „Streit mit Renate, dann Vergewaltigung" (Akt 20–24, Stefan *1968)
// traf am stärksten das Drama von 1999 (0.681), fast gleich stark die Szene von
// 1992 (0.592). Die Streuung im besten Abschnitt war 0 → fälschlich eindeutig.
const PROD_EVENTS = new Map([
  [10, [ev({ datum_year: 1999, datum_month: 8, ereignis: 'Renate entdeckt ihre zweite Schwangerschaft' })]],
  [11, [ev({ datum_year: 1999, ereignis: 'Stefan vergewaltigt Renate erneut' })]],
  [12, [ev({ datum_year: 1992, ereignis: 'Renate tritt der Damenriege bei' })]],
  [13, [ev({ datum_year: 1975, ereignis: 'Weit weg' })]],
]);
const runRivals = ({ rivals = [], aktFenster = null, top = 0.681 } = {}) => computeZeitVorschlaege({
  beats: [{ id: 1, status: 'im_buch', zeit: null, verworfen: 0 }],
  topPage: new Map([[1, { page_id: 10, page_name: 'Das nächste Drama', score: top }]]),
  rivals: new Map([[1, rivals]]),
  aktFenster: aktFenster ? new Map([[1, aktFenster]]) : new Map(),
  eventsByPage: PROD_EVENTS,
})[0];

test('gleich starke, anders datierte Fundstelle nimmt das Häkchen und wird genannt', () => {
  const v = runRivals({ rivals: [
    { page_id: 11, page_name: 'Die neue Sexualität', score: 0.611 },
    { page_id: 12, page_name: 'Das Vereinsleben', score: 0.592 },
  ] });
  assert.equal(v.zeit, 'August 1999', 'der Vorschlag selbst bleibt');
  assert.equal(v.spread, 0);
  assert.equal(v.eindeutig, false);
  assert.deepEqual(v.konkurrenz, [{ page_id: 12, page_name: 'Das Vereinsleben', zeit: '1992' }],
    'gleich datierte Konkurrentin (1999) zählt nicht');
});

test('Konkurrenz: deutlich schwächere Fundstelle zählt nicht, wörtlicher Treffer immer', () => {
  assert.equal(runRivals({ rivals: [{ page_id: 13, page_name: 'X', score: 0.5 }] }).eindeutig, true);
  assert.equal(runRivals({ rivals: [{ page_id: 13, page_name: 'X', score: null }] }).eindeutig, false);
  assert.equal(runRivals({ rivals: [{ page_id: 10, page_name: 'gleicher Abschnitt', score: 0.6 }] }).eindeutig, true,
    'zweiter Treffer im selben Abschnitt ist keine Konkurrenz');
});

test('Vorschlag ausserhalb des Akt-Fensters ist nicht eindeutig, innerhalb schon', () => {
  const aussen = runRivals({ aktFenster: { name: 'Erste Reife (20-24)', from: 1988, to: 1993 } });
  assert.equal(aussen.zeit, 'August 1999', 'der Akt liefert die Zeit nie');
  assert.equal(aussen.eindeutig, false);
  assert.deepEqual(aussen.akt, { name: 'Erste Reife (20-24)', from: 1988, to: 1993 });
  const innen = runRivals({ aktFenster: { name: 'Erste Krise (28-32)', from: 1996, to: 2001 } });
  assert.equal(innen.eindeutig, true);
  assert.equal(innen.akt, null);
});
