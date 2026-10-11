// Rechenkern der Kachel „Fortschritt" im Kapitel-Dashboard (Bearbeitungsstand).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeFortschritt, BRACH_DAYS } from '../../public/js/cards/kapitel-fortschritt.js';
import { MANUSKRIPT_STATUS } from '../../public/js/redaktion/status.js';

const NOW = new Date('2026-10-11T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();
const CHAIN = MANUSKRIPT_STATUS; // rohfassung, ueberarbeitet, redigiert, final

const PAGES = [
  { id: 1, name: 'Eins',  updated_at: daysAgo(40) }, // final, lange unberuehrt
  { id: 2, name: 'Zwei',  updated_at: daysAgo(45) }, // redigiert, seither geaendert
  { id: 3, name: 'Drei',  updated_at: daysAgo(2) },  // rohfassung, frisch
  { id: 4, name: 'Vier',  updated_at: daysAgo(90) }, // ohne Stufe
  { id: 5, name: 'Fuenf', updated_at: null },        // ohne Stufe, ohne Datum
];
const BY_PAGE = {
  1: { status: 'final' },
  2: { status: 'redigiert', stale: true },
  3: { status: 'rohfassung' },
};

test('Verteilung ueber die Kette, Segmente in Ketten-Reihenfolge, leere weggelassen', () => {
  const f = computeFortschritt(PAGES, BY_PAGE, CHAIN, { now: NOW });
  assert.equal(f.total, 5);
  assert.equal(f.set, 3);
  assert.equal(f.done, 'final');
  assert.equal(f.doneN, 1);
  assert.equal(f.stale, 1);
  assert.equal(f.brachDays, BRACH_DAYS);
  assert.deepEqual(f.segments.map(s => [s.key, s.cls, s.n]), [
    ['rohfassung', 'status0', 1],
    ['redigiert', 'status2', 1],
    ['final', 'status3', 1],
    ['ohne', 'ohne', 2],
  ]);
});

test('Liegt brach: nur unfertige, ab Schwelle, aeltester zuerst', () => {
  const f = computeFortschritt(PAGES, BY_PAGE, CHAIN, { now: NOW });
  // Eins ist final (zaehlt nicht), Drei ist frisch, Fuenf hat kein Datum.
  assert.deepEqual(f.brach.map(b => [b.name, b.status, b.days]), [
    ['Vier', null, 90],
    ['Zwei', 'redigiert', 45],
  ]);
  assert.equal(f.brachTotal, 2);
});

test('Liegt brach: Liste gedeckelt, Gesamtzahl bleibt', () => {
  const pages = Array.from({ length: 8 }, (_, i) => ({ id: 100 + i, name: 'P' + i, updated_at: daysAgo(31 + i) }));
  const f = computeFortschritt(pages, {}, CHAIN, { now: NOW, limit: 3 });
  assert.equal(f.brachTotal, 8);
  assert.equal(f.brach.length, 3);
  assert.equal(f.brach[0].name, 'P7');
});

test('Ohne gesetzte Stufe: set 0, alles „ohne"', () => {
  const f = computeFortschritt(PAGES, {}, CHAIN, { now: NOW });
  assert.equal(f.set, 0);
  assert.deepEqual(f.segments.map(s => s.key), ['ohne']);
});

test('Leerer Scope', () => {
  const f = computeFortschritt([], {}, CHAIN, { now: NOW });
  assert.equal(f.total, 0);
  assert.equal(f.set, 0);
  assert.equal(f.brachTotal, 0);
});
