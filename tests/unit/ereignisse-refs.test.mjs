// Ereignisse: Anker-Paare Name ↔ ID, gemeinsamer Vergleichsschlüssel, Rückabgleich
// der Kapitel-IDs nach der KI-Konsolidierung (P6), Suche und Bearbeiten-Diff.
//
// Paare: `kapitel[i]` gehört zu `chapter_ids[i]`, `seiten[i]` zu `page_ids[i]` —
// Template und Entity-Refs lesen beide über denselben Index. Wurden die zwei
// Listen je für sich dedupliziert, sprang ein Verweis mit der Beschriftung des
// einen Abschnitts in einen anderen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { normalizeEvent, addRefPair, eventGroupKey, sortEvents } from '../../public/js/cards/ereignisse/model.js';
import { applyEreignisseFilters } from '../../public/js/cards/ereignisse-card.js';
import { eventEditDiff } from '../../public/js/cards/ereignisse/edit.js';

const require = createRequire(import.meta.url);
const { groupFigureEvents, withRefIds, attachRefIds } = require('../../routes/jobs/komplett/zeitstrahl-refs.js');

test('addRefPair: gleichnamige Abschnitte mit verschiedener ID bleiben zwei Paare', () => {
  const names = [], ids = [];
  addRefPair(names, ids, 'Szene 1', 11);
  addRefPair(names, ids, 'Szene 1', 22);
  addRefPair(names, ids, 'Szene 1', 11);
  assert.deepEqual(names, ['Szene 1', 'Szene 1']);
  assert.deepEqual(ids, [11, 22]);
});

test('addRefPair: Name ohne ID verschiebt die folgenden IDs nicht', () => {
  const names = [], ids = [];
  addRefPair(names, ids, 'Prolog', null);
  addRefPair(names, ids, 'Kapitel 2', 5);
  assert.deepEqual(names, ['Prolog', 'Kapitel 2']);
  assert.deepEqual(ids, [null, 5]);
  // Kommt die ID später, wird das Paar ergänzt statt verdoppelt.
  addRefPair(names, ids, 'Prolog', 3);
  assert.deepEqual(ids, [3, 5]);
});

test('normalizeEvent: filtert Paare, nie eine Liste für sich', () => {
  const ev = normalizeEvent({ kapitel: ['A', '', 'C'], chapter_ids: [1, 2, null] });
  assert.deepEqual(ev.kapitel, ['A', 'C']);
  assert.deepEqual(ev.chapter_ids, [1, null]);
});

test('eventGroupKey: strukturiertes Datum, Leerraum- und Grossschreibungs-tolerant', () => {
  const a = eventGroupKey({ datum_year: 1985, datum_month: 5, ereignis: 'Anna  zieht um ' });
  const b = eventGroupKey({ datum_year: 1985, datum_month: 5, datum_label: 'Mai 1985', ereignis: 'anna zieht um' });
  assert.equal(a, b);
  assert.notEqual(a, eventGroupKey({ datum_year: 1986, ereignis: 'Anna zieht um' }));
  // 0-Platzhalter zählt als unbekannt, nicht als Jahr 0.
  assert.equal(eventGroupKey({ datum_year: 0, datum_label: '', ereignis: 'x' }), eventGroupKey({ ereignis: 'x' }));
});

test('sortEvents: Jahr 0 aus Altbestand sortiert wie «ohne Datum» ans Ende', () => {
  const out = sortEvents([{ id: 1, datum_year: 0, ereignis: 'alt' }, { id: 2, datum_year: 1990, ereignis: 'neu' }]);
  assert.deepEqual(out.map(e => e.id), [2, 1]);
});

const ROWS = [
  { fig_id: 'f1', fig_name: 'Anna', datum_year: 1985, ereignis: 'Umzug', kapitel: 'Einleitung', chapter_id: 101, seite: 'Szene 1', page_id: 1001 },
  { fig_id: 'f2', fig_name: 'Ben', datum_year: 1985, ereignis: 'umzug', kapitel: 'Einleitung', chapter_id: 101, seite: null, page_id: null },
  { fig_id: 'f2', fig_name: 'Ben', datum_year: 1999, ereignis: 'Abschied', kapitel: 'Einleitung', chapter_id: 202, seite: 'Szene 1', page_id: 2001 },
];

test('groupFigureEvents: Prompt-Form ohne IDs, IDs daneben', () => {
  const g = groupFigureEvents(ROWS, eventGroupKey);
  assert.equal(g.events.length, 2);
  const umzug = g.events.find(e => e.datum_year === 1985);
  assert.equal('chapter_ids' in umzug, false, 'IDs gehen nicht in den Prompt');
  assert.deepEqual(umzug.figuren.map(f => f.id), ['f1', 'f2']);
  const direct = withRefIds(g.events, g.refs).find(e => e.datum_year === 1985);
  assert.deepEqual(direct.chapter_ids, [101]);
  assert.deepEqual(direct.page_ids, [1001]);
});

test('attachRefIds: mehrdeutiger Kapitelname löst über Schlüssel bzw. Figur auf', () => {
  const g = groupFigureEvents(ROWS, eventGroupKey);
  const ki = [
    // gleicher Schlüssel wie die 1985er-Gruppe → deren Kapitel
    { datum_year: 1985, ereignis: 'Umzug', kapitel: ['Einleitung'], seiten: ['Szene 1'], figuren: [{ id: 'f1' }] },
    // umformuliert: nur Figur f2 trägt «Einleitung» in zwei Kapiteln → mehrdeutig
    { datum_year: 1999, ereignis: 'Ben geht', kapitel: ['Einleitung'], seiten: [], figuren: [{ id: 'f2' }] },
    // umformuliert, Figur f1 kennt «Einleitung» nur als 101
    { datum_year: 1985, ereignis: 'Anna verlässt das Dorf', kapitel: ['Einleitung'], figuren: [{ id: 'f1' }] },
  ];
  const out = attachRefIds(ki, g, eventGroupKey);
  assert.deepEqual(out[0].chapter_ids, [101]);
  assert.deepEqual(out[0].page_ids, [1001]);
  assert.deepEqual(out[1].chapter_ids, [], 'mehrdeutig → keine geratene ID');
  assert.deepEqual(out[2].chapter_ids, [101]);
});

test('Suche findet Figurennamen, Bedeutung und Datums-Label', () => {
  const events = [normalizeEvent({ id: 1, ereignis: 'Umzug', bedeutung: 'Neuanfang', datum_label: 'Mai 1985', figuren: [{ id: 'f1', name: 'Anna' }] })];
  for (const q of ['anna', 'neuanfang', '1985']) {
    assert.equal(applyEreignisseFilters(events, { suche: q }).length, 1, q);
  }
});

test('eventEditDiff: nur geänderte Felder, leer → null, Datum gegen das Label', () => {
  const ev = { ereignis: 'Umzug', datum_label: '1985', typ: 'persoenlich', subtyp: 'umzug', bedeutung: '' };
  assert.deepEqual(eventEditDiff(ev, { ...ev }), {});
  assert.deepEqual(eventEditDiff(ev, { ...ev, datum_label: '', bedeutung: ' neu ' }), { datum_label: null, bedeutung: 'neu' });
});
