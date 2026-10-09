// groupedRows: Render-Plan der Combobox-Liste (Kopfzeilen + Optionen).
//
// Warum ueberhaupt getestet: die Zeilen gehen durch ein `x-for :key`, und Alpine
// wirft bei doppelten Keys eine der beiden Zeilen weg. Sichtbar wird das nur als
// fehlende Kopfzeile in einer Liste, in der dieselbe Gruppe spaeter noch einmal
// auftaucht — ein Fehler, den keine Zustandspruefung meldet.

import test from 'node:test';
import assert from 'node:assert/strict';

import { comboboxData } from '../../public/js/combobox.js';

function rowsFor(options) {
  const cb = comboboxData({ placeholder: 'x' });
  cb.options = options;
  return cb.groupedRows;
}

test('Kopfzeile je Gruppenwechsel, Optionen indexieren `filtered`', () => {
  const rows = rowsFor([
    { value: 1, label: 'A', group: 'G1' },
    { value: 2, label: 'B', group: 'G1' },
    { value: 3, label: 'C', group: 'G2' },
  ]);
  assert.deepEqual(rows.map(r => r.kind), ['header', 'option', 'option', 'header', 'option']);
  assert.deepEqual(rows.filter(r => r.kind === 'header').map(r => r.label), ['G1', 'G2']);
  assert.deepEqual(rows.filter(r => r.kind === 'option').map(r => r.optIndex), [0, 1, 2]);
});

test('ohne `group` bleibt es eine reine Optionsliste', () => {
  const rows = rowsFor([{ value: 1, label: 'A' }, { value: 2, label: 'B' }]);
  assert.deepEqual(rows.map(r => r.kind), ['option', 'option']);
});

test('Keys sind eindeutig — auch wenn dieselbe Gruppe erneut auftaucht', () => {
  const rows = rowsFor([
    { value: 1, label: 'A', group: 'G1' },
    { value: 2, label: 'B', group: 'G2' },
    { value: 3, label: 'C', group: 'G1' },
  ]);
  // Zwei G1-Kopfzeilen sind hier korrekt (die Gruppe ist nicht zusammenhaengend)
  // — sie duerfen sich nur nicht denselben Key teilen.
  assert.equal(rows.filter(r => r.kind === 'header').length, 3);
  const keys = rows.map(r => r.key);
  assert.equal(new Set(keys).size, keys.length, `doppelte Keys: ${keys.join(', ')}`);
});

test('Keys sind auch bei doppeltem Wert in derselben Gruppe eindeutig', () => {
  const rows = rowsFor([
    { value: 7, label: 'A', group: 'G' },
    { value: 7, label: 'A (zweiter Auftritt)', group: 'G' },
  ]);
  const keys = rows.map(r => r.key);
  assert.equal(new Set(keys).size, keys.length, `doppelte Keys: ${keys.join(', ')}`);
});

// Keys duerfen sich beim Filtern nicht verschieben: stuende der Listen-Index im
// Key, aenderte jedes getippte Zeichen alle Keys, und `x-for` baute jede Zeile
// neu statt sie wiederzuverwenden (Ruckeln beim Tippen in langen Listen).
test('Keys bleiben beim Filtern stabil', () => {
  const cb = comboboxData({ placeholder: 'x' });
  cb.options = [
    { value: 1, label: 'Anna', group: 'G1' },
    { value: 2, label: 'Bert', group: 'G1' },
    { value: 3, label: 'Berta', group: 'G2' },
  ];
  const before = new Map(cb.groupedRows.filter(r => r.kind === 'option').map(r => [r.opt.value, r.key]));
  cb.query = 'ber';
  const after = cb.groupedRows.filter(r => r.kind === 'option');
  assert.deepEqual(after.map(r => r.opt.value), [2, 3]);
  for (const r of after) assert.equal(r.key, before.get(r.opt.value));
  assert.deepEqual(after.map(r => r.optIndex), [0, 1]);
});

test('filtered folgt einem neu zugewiesenen options-Array', () => {
  const cb = comboboxData({ placeholder: 'x' });
  cb.options = [{ value: 1, label: 'A' }];
  assert.equal(cb.filtered.length, 1);
  cb.options = [{ value: 1, label: 'A' }, { value: 2, label: 'B' }];
  assert.equal(cb.filtered.length, 2);
});
