// Zeit-Messung der Plot-Werkstatt (lib/plot-time-consistency.js) — pure Rechnung.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeTimeFindings } = require('../../lib/plot-time-consistency.js');
const { timeKeyOf } = require('../../lib/time-key.js');

const FIGS = new Map([
  ['f1', { name: 'Mara', geburtsjahr: 1979 }],
  ['f2', { name: 'Jonas', geburtsjahr: null }],
]);

// `jahr` ist Test-Kurzschrift für eine reine Jahresangabe; `zeit` darf jeden
// Freitext tragen. Das Fenster rechnet wie die Route lib/time-key.js aus.
function beat(over = {}) {
  const { jahr, ...rest } = over;
  const zeit = 'zeit' in rest ? rest.zeit : (jahr === undefined ? '1990' : (jahr === null ? null : String(jahr)));
  return { id: 1, titel: 'Beat', status: 'im_buch', verworfen: 0, fig_ids: [], ordnung: 0, ...rest, zeit, key: timeKeyOf(zeit) };
}
const codes = f => f.map(x => x.code);

test('undatiert ist ungeprueft: ohne jahr keine Befunde', () => {
  const b = beat({ jahr: null, zeit: null, fig_ids: ['f1'] });
  assert.deepEqual(computeTimeFindings({ beats: [b], figures: FIGS }), []);
});

test('verworfene Beats zaehlen nicht (sie sollen nicht ins Buch)', () => {
  const b = beat({ jahr: 1970, fig_ids: ['f1'], verworfen: 1 });
  assert.deepEqual(computeTimeFindings({ beats: [b], figures: FIGS }), []);
});

test('beatVorGeburt: Beat spielt vor der Geburt einer beteiligten Figur', () => {
  const b = beat({ jahr: 1970, fig_ids: ['f1'] });
  const f = computeTimeFindings({ beats: [b], figures: FIGS });
  assert.deepEqual(codes(f), ['beatVorGeburt']);
  assert.equal(f[0].schwere, 'kritisch');
  assert.equal(f[0].params.figur, 'Mara');
  assert.equal(f[0].params.geburtsjahr, 1979);
  assert.equal(f[0].params.zeit, '1970');
});

test('Figur ohne Geburtsjahr erzeugt keinen Alters-Befund', () => {
  const b = beat({ jahr: 1900, fig_ids: ['f2'] });
  assert.deepEqual(computeTimeFindings({ beats: [b], figures: FIGS }), []);
});

test('ein Kind im Beat ist kein Befund (das Alter steht an der Karte)', () => {
  const b = beat({ jahr: 1985, fig_ids: ['f1'] });     // Mara *1979 → 6
  assert.deepEqual(computeTimeFindings({ beats: [b], figures: FIGS }), []);
});

test('chronologieBruch misst gegen das bisherige Maximum, nicht den Vorgaenger', () => {
  // Eine einzelne Ruecklende darf keine Kette von Folgefehlern erzeugen.
  const beats = [
    beat({ id: 1, titel: 'A', jahr: 2000, ordnung: 0 }),
    beat({ id: 2, titel: 'B', jahr: 1990, ordnung: 1 }),   // Rueckblende
    beat({ id: 3, titel: 'C', jahr: 2001, ordnung: 2 }),   // wieder vorwaerts
  ];
  const f = computeTimeFindings({ beats, figures: FIGS });
  assert.deepEqual(codes(f), ['chronologieBruch']);
  assert.equal(f[0].beat_id, 2);
  assert.equal(f[0].params.vorBeat, 'A');
});

test('aufsteigende Jahre erzeugen keinen Bruch', () => {
  const beats = [
    beat({ id: 1, jahr: 1990, ordnung: 0 }),
    beat({ id: 2, jahr: 1990, ordnung: 1 }),   // Gleichstand ist kein Bruch
    beat({ id: 3, jahr: 1995, ordnung: 2 }),
  ];
  assert.deepEqual(computeTimeFindings({ beats, figures: FIGS }), []);
});

test('Board-Reihenfolge entscheidet, nicht die Array-Reihenfolge', () => {
  const beats = [
    beat({ id: 3, titel: 'C', jahr: 1990, ordnung: 2 }),
    beat({ id: 1, titel: 'A', jahr: 2000, ordnung: 0 }),
  ];
  const f = computeTimeFindings({ beats, figures: FIGS });
  assert.deepEqual(codes(f), ['chronologieBruch']);
  assert.equal(f[0].beat_id, 3, 'der spaeter gelesene Beat traegt den Befund');
});

test('zeitAusserhalbBuch nur mit bekannter Buchspanne', () => {
  const b = beat({ jahr: 1800 });
  assert.deepEqual(computeTimeFindings({ beats: [b], figures: FIGS, bookSpan: null }), []);
  const f = computeTimeFindings({ beats: [b], figures: FIGS, bookSpan: { minYear: 1980, maxYear: 2000 } });
  assert.deepEqual(codes(f), ['zeitAusserhalbBuch']);
  assert.equal(f[0].schwere, 'schwach');
});

test('Befunde sind nach Schwere sortiert', () => {
  const beats = [
    beat({ id: 1, titel: 'A', jahr: 2000, ordnung: 0 }),
    beat({ id: 2, titel: 'B', jahr: 1970, ordnung: 1, fig_ids: ['f1'] }),
  ];
  const f = computeTimeFindings({ beats, figures: FIGS, bookSpan: { minYear: 1980, maxYear: 2010 } });
  assert.deepEqual(codes(f), ['beatVorGeburt', 'chronologieBruch', 'zeitAusserhalbBuch']);
  assert.ok(f.every(x => x.quelle === 'messung'));
});

// ── Lesereihenfolge pro Lane (lib/plot-reading-order.js) ─────────────────────
const { laneReadingOrder, beatsInReadingOrder } = require('../../lib/plot-reading-order.js');

test('chronologieBruch nur innerhalb einer Lane — parallele Stränge sind kein Rückschritt', () => {
  const beats = [
    beat({ id: 1, titel: 'A1', jahr: 1987, lane: 't1', ordnung: 0 }),
    beat({ id: 2, titel: 'B1', jahr: 1950, lane: 't2', ordnung: 0 }),
    beat({ id: 3, titel: 'B2', jahr: 1955, lane: 't2', ordnung: 1 }),
  ];
  assert.deepEqual(computeTimeFindings({ beats, figures: FIGS }), []);
  const back = [...beats, beat({ id: 4, titel: 'A2', jahr: 1980, lane: 't1', ordnung: 1 })];
  const f = computeTimeFindings({ beats: back, figures: FIGS });
  assert.deepEqual(codes(f), ['chronologieBruch']);
  assert.equal(f[0].beat_id, 4);
  assert.equal(f[0].params.vorBeat, 'A1');
});

test('laneReadingOrder: geforkter Strang liest seine eigenen Akte, andere die geteilten', () => {
  const acts = [
    { id: 10, thread_id: null, position: 1 }, { id: 11, thread_id: null, position: 0 },
    { id: 20, thread_id: 2, position: 1 }, { id: 21, thread_id: 2, position: 0 },
  ];
  const threads = [{ id: 2, position: 1 }, { id: 1, position: 0 }];
  const beats = [
    { id: 100, act_id: 10, thread_id: 1, sort_order: 0 },
    { id: 101, act_id: 11, thread_id: 1, sort_order: 1 },
    { id: 102, act_id: 11, thread_id: 1, sort_order: 0 },
    { id: 200, act_id: 20, thread_id: 2, sort_order: 0 },
    { id: 201, act_id: 21, thread_id: 2, sort_order: 0 },
    { id: 300, act_id: 10, thread_id: null, sort_order: 0 },
  ];
  const lanes = laneReadingOrder({ acts, threads, beats });
  assert.deepEqual(lanes.map(l => l.key), ['t1', 't2', 'none']);
  assert.deepEqual(lanes[0].acts.map(a => a.id), [11, 10]);
  assert.deepEqual(lanes[0].beats.map(b => b.id), [102, 101, 100]);
  assert.deepEqual(lanes[1].acts.map(a => a.id), [21, 20]);
  assert.deepEqual(lanes[1].beats.map(b => b.id), [201, 200]);
  assert.deepEqual(lanes[2].beats.map(b => b.id), [300]);
  const flat = beatsInReadingOrder({ acts, threads, beats });
  assert.deepEqual(flat.map(b => [b.id, b.lane, b.ordnung]),
    [[102, 't1', 0], [101, 't1', 1], [100, 't1', 2], [201, 't2', 0], [200, 't2', 1], [300, 'none', 0]]);
});

test('laneReadingOrder: Beat auf lane-fremdem Akt (Altdaten) landet am Lane-Ende statt zu verschwinden', () => {
  const acts = [{ id: 10, thread_id: null, position: 0 }, { id: 20, thread_id: 2, position: 0 }];
  const beats = [
    { id: 1, act_id: 10, thread_id: 2, sort_order: 0 },
    { id: 2, act_id: 20, thread_id: 2, sort_order: 5 },
  ];
  const lanes = laneReadingOrder({ acts, threads: [{ id: 2, position: 0 }], beats });
  assert.deepEqual(lanes[0].beats.map(b => b.id), [2, 1]);
});

// ── Zeitfenster statt Jahreszahl (lib/time-key.js) ───────────────────────────

test('v. Chr. und dreistellige Jahre sind datiert, nicht ungeprueft', () => {
  const beats = [
    beat({ id: 1, titel: 'A', zeit: '312 n. Chr.', ordnung: 0 }),
    beat({ id: 2, titel: 'B', zeit: '500 v. Chr.', ordnung: 1 }),
  ];
  const f = computeTimeFindings({ beats, figures: FIGS });
  assert.deepEqual(codes(f), ['chronologieBruch']);
  assert.equal(f[0].params.vorZeit, '312 n. Chr.');
});

test('chronologieBruch auf Monatsebene, Ueberlappung ist kein Bruch', () => {
  const bruch = [
    beat({ id: 1, titel: 'A', zeit: 'Mai 1987', ordnung: 0 }),
    beat({ id: 2, titel: 'B', zeit: 'März 1987', ordnung: 1 }),
  ];
  assert.deepEqual(codes(computeTimeFindings({ beats: bruch, figures: FIGS })), ['chronologieBruch']);
  const grob = [
    beat({ id: 1, titel: 'A', zeit: 'März 1987', ordnung: 0 }),
    beat({ id: 2, titel: 'B', zeit: '1987', ordnung: 1 }),          // umfasst März
    beat({ id: 3, titel: 'C', zeit: 'Sommer 1987', ordnung: 2 }),
    beat({ id: 4, titel: 'D', zeit: 'um 1986', ordnung: 3 }),       // 1984–1988
  ];
  assert.deepEqual(computeTimeFindings({ beats: grob, figures: FIGS }), []);
});

test('Story-Tage werden gemessen, aber nie gegen Kalenderzeit', () => {
  const beats = [
    beat({ id: 1, titel: 'A', zeit: 'Tag 5', ordnung: 0 }),
    beat({ id: 2, titel: 'B', zeit: '1990', ordnung: 1 }),
    beat({ id: 3, titel: 'C', zeit: 'Tag 3', ordnung: 2 }),
    beat({ id: 4, titel: 'D', zeit: '1980', ordnung: 3 }),
  ];
  const f = computeTimeFindings({ beats, figures: FIGS });
  assert.deepEqual(f.map(x => [x.code, x.beat_id]).sort(), [['chronologieBruch', 3], ['chronologieBruch', 4]]);
});

test('beatVorGeburt misst das Fensterende: eine Spanne ueber die Geburt ist kein Fehler', () => {
  const ueber = beat({ zeit: '1975–1985', fig_ids: ['f1'] });     // Mara *1979
  assert.ok(!codes(computeTimeFindings({ beats: [ueber], figures: FIGS })).includes('beatVorGeburt'));
  const davor = beat({ zeit: '1970er', fig_ids: ['f1'] });         // 1970–1979 → endet im Geburtsjahr
  assert.ok(!codes(computeTimeFindings({ beats: [davor], figures: FIGS })).includes('beatVorGeburt'));
  const klar = beat({ zeit: '1960er', fig_ids: ['f1'] });
  assert.deepEqual(codes(computeTimeFindings({ beats: [klar], figures: FIGS })), ['beatVorGeburt']);
});

// ── Figur an zwei Orten zugleich ─────────────────────────────────────────────

const ZH = { id: 'zh', name: 'Zürich' };
const ALT = { id: 'alt', name: 'Altstadt' };
const BE = { id: 'be', name: 'Berlin' };
const PARENTS = new Map([['alt', 'zh']]);

test('figurAnZweiOrten: dieselbe Figur am selben Tag an unvertraeglichen Orten', () => {
  const beats = [
    beat({ id: 1, titel: 'Abreise', zeit: '12.03.1987', fig_ids: ['f2'], locations: [ZH], lane: 't1' }),
    beat({ id: 2, titel: 'Ankunft', zeit: '12. März 1987', fig_ids: ['f2'], locations: [BE], lane: 't2' }),
  ];
  const f = computeTimeFindings({ beats, figures: FIGS, locParents: PARENTS });
  assert.deepEqual(codes(f), ['figurAnZweiOrten']);
  assert.equal(f[0].schwere, 'stark');
  assert.equal(f[0].beat_id, 2, 'Befund am Beat mit der hoeheren ID');
  assert.deepEqual(
    { figur: f[0].params.figur, ort: f[0].params.ort, anderOrt: f[0].params.anderOrt, anderBeat: f[0].params.anderBeat },
    { figur: 'Jonas', ort: 'Berlin', anderOrt: 'Zürich', anderBeat: 'Abreise' });
});

test('figurAnZweiOrten: verschachtelte Orte, andere Tage, Monatsgenauigkeit und unsicher sind kein Befund', () => {
  const run = (a, b) => computeTimeFindings({
    beats: [beat({ id: 1, fig_ids: ['f1'], ...a }), beat({ id: 2, fig_ids: ['f1'], ordnung: 1, ...b })],
    figures: FIGS, locParents: PARENTS,
  }).filter(x => x.code === 'figurAnZweiOrten');
  assert.deepEqual(run({ zeit: '12.03.1987', locations: [ZH] }, { zeit: '12.03.1987', locations: [ALT] }), []);
  assert.deepEqual(run({ zeit: '12.03.1987', locations: [ZH] }, { zeit: '13.03.1987', locations: [BE] }), []);
  assert.deepEqual(run({ zeit: 'März 1987', locations: [ZH] }, { zeit: 'März 1987', locations: [BE] }), []);
  assert.deepEqual(run({ zeit: 'ca. 12.03.1987', locations: [ZH] }, { zeit: '12.03.1987', locations: [BE] }), []);
  assert.deepEqual(run({ zeit: '12.03.1987', locations: [ZH] }, { zeit: '12.03.1987', locations: [BE], fig_ids: ['f2'] }), []);
  // Story-Tage sind tagesgenau: gleicher Tag, verschiedene Orte → Befund.
  assert.equal(run({ zeit: 'Tag 3', locations: [ZH] }, { zeit: 'Tag 3', locations: [BE] }).length, 1);
});

// ── Akt-Alter und Stand im Manuskript ────────────────────────────────────────

const STEFAN = new Map([['st', { name: 'Stefan', geburtsjahr: 1968, stand: { jahr: 2000, ereignis: 'Silvester im Kiff' } }]]);
const KRISE = { name: 'Erste Krise (28-32)', von: 28, bis: 32 };

test('alterAusserhalbAkt: Alter der Strang-Figur liegt ausserhalb der Akt-Spanne', () => {
  const f = computeTimeFindings({ beats: [beat({ zeit: '2008', strandFig: 'st', actAge: KRISE })], figures: STEFAN });
  assert.deepEqual(codes(f), ['alterAusserhalbAkt']);
  assert.equal(f[0].schwere, 'mittel');
  assert.deepEqual([f[0].params.alter, f[0].params.von, f[0].params.bis], ['40', 28, 32]);
  // Überschneidung reicht: 1995–1997 heisst 27–29, das trifft 28–32.
  assert.deepEqual(computeTimeFindings({ beats: [beat({ zeit: '1995–1997', strandFig: 'st', actAge: KRISE })], figures: STEFAN }), []);
  // Ohne Akt-Spanne oder ohne Strang-Figur kein Befund.
  assert.deepEqual(computeTimeFindings({ beats: [beat({ zeit: '2008', strandFig: 'st' })], figures: STEFAN }), []);
  assert.deepEqual(computeTimeFindings({ beats: [beat({ zeit: '2008', actAge: KRISE })], figures: STEFAN }), []);
});

test('alterAusserhalbAkt: nur das Geburtsjahr ist bekannt — ein Jahr Toleranz nach oben', () => {
  // 2001 ist Stefan 33 oder (vor dem Geburtstag) noch 32 → passt zu 28–32.
  assert.deepEqual(computeTimeFindings({ beats: [beat({ zeit: '2001', strandFig: 'st', actAge: KRISE })], figures: STEFAN }), []);
  // 2002 ist er 33 oder 34 → ausserhalb.
  assert.deepEqual(codes(computeTimeFindings({ beats: [beat({ zeit: '2002', strandFig: 'st', actAge: KRISE })], figures: STEFAN })), ['alterAusserhalbAkt']);
  // Nach unten keine Toleranz: 1995 ist er 26 oder 27 → vor 28.
  assert.deepEqual(codes(computeTimeFindings({ beats: [beat({ zeit: '1995', strandFig: 'st', actAge: KRISE })], figures: STEFAN })), ['alterAusserhalbAkt']);
});

test('vorStandImManuskript: nur geplante Beats vor dem Stand der Strang-Figur, schwach', () => {
  const geplant = beat({ zeit: '1997', status: 'geplant', strandFig: 'st' });
  const f = computeTimeFindings({ beats: [geplant], figures: STEFAN });
  assert.deepEqual(codes(f), ['vorStandImManuskript']);
  assert.equal(f[0].schwere, 'schwach');
  assert.equal(f[0].params.ereignis, 'Silvester im Kiff');
  assert.deepEqual(computeTimeFindings({ beats: [beat({ zeit: '1997', strandFig: 'st' })], figures: STEFAN }), [], 'im Buch: kein Befund');
  assert.deepEqual(computeTimeFindings({ beats: [beat({ zeit: '2003', status: 'geplant', strandFig: 'st' })], figures: STEFAN }), [], 'nach dem Stand');
});

test('zeitAusserhalbBuch nur für Beats im Buch — geplante erweitern die Spanne', () => {
  const span = { minYear: 1980, maxYear: 2000 };
  assert.deepEqual(codes(computeTimeFindings({ beats: [beat({ jahr: 2010 })], figures: FIGS, bookSpan: span })), ['zeitAusserhalbBuch']);
  assert.deepEqual(computeTimeFindings({ beats: [beat({ jahr: 2010, status: 'geplant' })], figures: FIGS, bookSpan: span }), []);
});
