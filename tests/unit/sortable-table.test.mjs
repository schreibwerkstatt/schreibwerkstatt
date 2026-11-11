// sortRows: pure Sort-Logik fuer die sortableTable-Alpine-Komponente.
// Testet alle drei Typen (string/number/date), Direction-Toggle und
// Null-Sink-Garantie.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sortRows } from '../../public/js/sortable-table.js';

test('sortRows: string asc via localeCompare', () => {
  const rows = [{ name: 'Zebra' }, { name: 'apfel' }, { name: 'Bär' }];
  const out = sortRows(rows, 'name', 'asc');
  assert.deepEqual(out.map((r) => r.name), ['apfel', 'Bär', 'Zebra']);
});

test('sortRows: string desc kehrt um', () => {
  const rows = [{ name: 'a' }, { name: 'c' }, { name: 'b' }];
  const out = sortRows(rows, 'name', 'desc');
  assert.deepEqual(out.map((r) => r.name), ['c', 'b', 'a']);
});

test('sortRows: number asc/desc (Auto-Detection)', () => {
  const rows = [{ n: 10 }, { n: 2 }, { n: 100 }];
  assert.deepEqual(sortRows(rows, 'n', 'asc').map((r) => r.n), [2, 10, 100]);
  assert.deepEqual(sortRows(rows, 'n', 'desc').map((r) => r.n), [100, 10, 2]);
});

test('sortRows: typeHint "number" coerced aus String', () => {
  const rows = [{ x: '10' }, { x: '2' }, { x: '100' }];
  const out = sortRows(rows, 'x', 'asc', 'number');
  assert.deepEqual(out.map((r) => r.x), ['2', '10', '100']);
});

test('sortRows: date asc nach ISO-Timestamp', () => {
  const rows = [
    { at: '2026-05-04T10:00:00Z' },
    { at: '2026-05-01T08:00:00Z' },
    { at: '2026-05-04T09:00:00Z' },
  ];
  const out = sortRows(rows, 'at', 'asc');
  assert.deepEqual(out.map((r) => r.at), [
    '2026-05-01T08:00:00Z',
    '2026-05-04T09:00:00Z',
    '2026-05-04T10:00:00Z',
  ]);
});

test('sortRows: number null/undefined → 0 (kein Sink)', () => {
  // Bewusste Designentscheidung: Numeric-Coerce schluckt null→0. Wer ein
  // Sink-Verhalten will, nimmt typeHint 'date' (siehe naechster Test).
  const rows = [{ n: 5 }, { n: null }, { n: 1 }];
  const asc = sortRows(rows, 'n', 'asc', 'number');
  assert.equal(asc[0].n, null);
  assert.equal(asc[asc.length - 1].n, 5);
});

test('sortRows: date null sinkt IMMER ans Ende', () => {
  const rows = [
    { at: '2026-05-04T10:00:00Z' },
    { at: null },
    { at: '2026-05-01T08:00:00Z' },
  ];
  const asc = sortRows(rows, 'at', 'asc');
  const desc = sortRows(rows, 'at', 'desc');
  assert.equal(asc[asc.length - 1].at, null);
  assert.equal(desc[desc.length - 1].at, null);
});

test('sortRows: returnt neue Array-Instanz (keine Mutation der Quelle)', () => {
  const rows = [{ n: 2 }, { n: 1 }];
  const out = sortRows(rows, 'n', 'asc');
  assert.notEqual(out, rows);
  assert.equal(rows[0].n, 2); // unveraendert
});

test('sortRows: leeres Array → []', () => {
  assert.deepEqual(sortRows([], 'x', 'asc'), []);
});

test('sortRows: ohne key → Kopie ohne Sort', () => {
  const rows = [{ n: 3 }, { n: 1 }, { n: 2 }];
  const out = sortRows(rows, null, 'asc');
  assert.deepEqual(out, rows);
  assert.notEqual(out, rows);
});

test('sortRows: numeric:true Collator sortiert "item2" vor "item10"', () => {
  const rows = [{ k: 'item10' }, { k: 'item2' }, { k: 'item1' }];
  const out = sortRows(rows, 'k', 'asc');
  assert.deepEqual(out.map((r) => r.k), ['item1', 'item2', 'item10']);
});

test('windowRows: kürzt auf das Fenster, kurze Listen bleiben dieselbe Referenz', async () => {
  const { windowRows } = await import('../../public/js/sortable-table.js');
  const rows = Array.from({ length: 5 }, (_, i) => ({ i }));
  assert.deepEqual(windowRows(rows, 3).map(r => r.i), [0, 1, 2]);
  assert.equal(windowRows(rows, 5), rows);
  assert.equal(windowRows(rows, 10), rows);
});
