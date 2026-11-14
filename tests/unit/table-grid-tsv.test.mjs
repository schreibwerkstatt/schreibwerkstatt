// parseTsv (public/js/editor/notebook/toolbar/table-grid.js): Text aus einer
// Tabellenkalkulation, eingefuegt in eine Zelle des Tabellen-Dialogs, verteilt
// sich ueber das Gitter. Excel schliesst Zellen mit Umbruch/Tab in
// Anfuehrungszeichen ein und haengt eine Leerzeile an.

import test from 'node:test';
import assert from 'node:assert/strict';

const { parseTsv } = await import('../../public/js/editor/notebook/toolbar/table-grid.js');

test('parseTsv: Zeilen × Zellen, abschliessende Leerzeile faellt weg', () => {
  assert.deepEqual(parseTsv('A\tB\r\nC\tD\r\n'), [['A', 'B'], ['C', 'D']]);
});

test('parseTsv: Anfuehrungszeichen halten Umbruch und Tab, die zum Leerzeichen werden', () => {
  assert.deepEqual(parseTsv('"x\ny"\t"a\tb"\n"sagt ""hallo"""\t'), [['x y', 'a b'], ['sagt "hallo"', '']]);
});

test('parseTsv: Anfuehrungszeichen mitten in der Zelle sind Text', () => {
  assert.deepEqual(parseTsv('5" Zoll\tok'), [['5" Zoll', 'ok']]);
});

test('parseTsv: ungleich lange Zeilen bleiben ungleich (Auffuellen macht das Gitter)', () => {
  assert.deepEqual(parseTsv('a\tb\tc\nd'), [['a', 'b', 'c'], ['d']]);
});
