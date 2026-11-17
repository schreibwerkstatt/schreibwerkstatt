// Tests für die geteilten Jahr×Monat-Heatmap-Helfer (public/js/book/ymheatmap.js):
// Quartil-Bucketing (quartileLevelFor) + aktueller Monat (currentMonthKey).
// Die beiden Konsumenten (Rückblick-Karte + Buch-Übersicht) hängen daran.
import test from 'node:test';
import assert from 'node:assert/strict';

const { quartileLevelFor, currentMonthKey } = await import('../../public/js/book/ymheatmap.js');

test('quartileLevelFor: 0/negativ → Level 0', () => {
  const lvl = quartileLevelFor([1, 2, 3, 4]);
  assert.equal(lvl(0), 0);
  assert.equal(lvl(-5), 0);
});

test('quartileLevelFor: monoton steigend, deckt alle vier positiven Stufen ab', () => {
  const counts = [1, 2, 3, 4, 5, 6, 7, 8];
  const lvl = quartileLevelFor(counts);
  const levels = counts.map(lvl);
  for (let i = 1; i < levels.length; i++) assert.ok(levels[i] >= levels[i - 1]);
  assert.deepEqual([...new Set(levels)].sort(), [1, 2, 3, 4]);
  assert.equal(lvl(8), 4); // klar über dem 75%-Perzentil → oberste Stufe
});

test('quartileLevelFor: leere Datenlage → Level 0 (der einzige real vorkommende Fall)', () => {
  // Ist `counts` leer, hat kein Monat Einträge → levelFor wird nur mit 0
  // aufgerufen. Genau das gaben wir hier ab.
  const lvl = quartileLevelFor([]);
  assert.equal(lvl(0), 0);
});

test('quartileLevelFor: nullwerte werden ignoriert (nur positive zählen)', () => {
  // Einzige positive Datenlage → alle Quartil-Schwellen kollabieren auf 4,
  // der Wert landet in der untersten positiven Stufe (Level 1).
  const lvl = quartileLevelFor([0, 0, 4, 0]);
  assert.equal(lvl(4), 1);
  assert.equal(lvl(0), 0);
});

test('currentMonthKey: liefert YYYY-MM', () => {
  assert.match(currentMonthKey(), /^\d{4}-\d{2}$/);
});

test('ymHeatCellClass: Stufe, Jahres-Spalte, Rückblick, veraltet, Auswahl', async () => {
  const { ymHeatCellClass } = await import('../../public/js/book/ymheatmap.js');
  const base = { key: '2024-03', level: 2, hasRueckblick: false, stale: false, isCurrent: false };
  assert.equal(ymHeatCellClass(base), 'ymheat-cell--lvl2');
  assert.equal(ymHeatCellClass({ ...base, hasRueckblick: true, stale: true }, '2024-03'),
    'ymheat-cell--lvl2 ymheat-cell--has ymheat-cell--stale ymheat-cell--active');
  assert.equal(ymHeatCellClass({ ...base, key: '2024', isYear: true }, '2024-03'),
    'ymheat-cell--lvl2 ymheat-cell--year');
});
