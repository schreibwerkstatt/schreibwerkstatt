import { test } from 'node:test';
import assert from 'node:assert/strict';
import { figurAnzeigeName } from '../../public/js/book/figur-name.js';

test('mehrteiliger Name: Kurzname ist der Anzeigename', () => {
  assert.equal(figurAnzeigeName({ name: 'Anna Berger', kurzname: 'Anna' }), 'Anna');
  assert.equal(figurAnzeigeName({ name: 'Robert Meier', kurzname: 'Bobby' }), 'Bobby');
});

test('einteiliger Name: bleibt, auch wenn ein Kurzname gesetzt ist', () => {
  assert.equal(figurAnzeigeName({ name: 'Robert', kurzname: 'Ro' }), 'Robert');
});

test('fehlende Felder: fällt auf das jeweils andere zurück', () => {
  assert.equal(figurAnzeigeName({ name: 'Anna Berger', kurzname: '' }), 'Anna Berger');
  assert.equal(figurAnzeigeName({ name: '', kurzname: 'Ro' }), 'Ro');
  assert.equal(figurAnzeigeName(null), '');
});
