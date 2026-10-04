// Ideen-Stufen pro Buch: SSoT-Gleichstand (Server ↔ Frontend), Normalisierung
// und die Spalten des Boards (docs/ideen-board.md, „Stufen pro Buch").
//
// Kernaussage: Abschalten heisst „nicht mehr anbieten", nicht „ausblenden" —
// eine Idee in einer abgeschalteten Stufe behaelt ihre Spalte, bis sie leer ist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

const server = require(path.join(ROOT, 'lib', 'ideen-status.js'));
const shared = await import(path.join(ROOT, 'public', 'js', 'book', 'ideen-shared.js'));
const { boardColumns } = await import(path.join(ROOT, 'public', 'js', 'book', 'ideen-board', 'model.js'));

test('Stufen pro Buch: feste/schaltbare Stufen gleich in Server und Frontend', () => {
  assert.deepEqual(shared.IDEE_FIXED_STATUSES, server.IDEE_FIXED_STATUSES);
  assert.deepEqual(shared.IDEE_OPTIONAL_STATUSES, server.IDEE_OPTIONAL_STATUSES);
  assert.deepEqual(server.IDEE_FIXED_STATUSES, ['offen', 'erledigt']);
  assert.deepEqual(
    [...server.IDEE_FIXED_STATUSES, ...server.IDEE_OPTIONAL_STATUSES].sort(),
    [...server.IDEE_STATUSES].sort(),
  );
});

test('normalizeIdeeStages: NULL = alle, feste immer drin, kanonische Reihenfolge, Unbekanntes weg', () => {
  const cases = [
    [null, ['offen', 'in_arbeit', 'erledigt', 'verworfen']],
    [undefined, ['offen', 'in_arbeit', 'erledigt', 'verworfen']],
    [[], ['offen', 'erledigt']],
    ['', ['offen', 'erledigt']],
    [['verworfen', 'offen'], ['offen', 'erledigt', 'verworfen']],
    ['in_arbeit,quatsch', ['offen', 'in_arbeit', 'erledigt']],
    [' verworfen , in_arbeit ', ['offen', 'in_arbeit', 'erledigt', 'verworfen']],
  ];
  for (const [input, want] of cases) {
    assert.deepEqual(server.normalizeIdeeStages(input), want, `server ${JSON.stringify(input)}`);
    assert.deepEqual(shared.normalizeIdeeStages(input), want, `shared ${JSON.stringify(input)}`);
  }
  assert.equal(server.serializeIdeeStages(['verworfen']), 'offen,erledigt,verworfen');
});

test('boardColumns: nur aktive Stufen, wenn die abgeschalteten leer sind', () => {
  const ideen = [{ status: 'offen' }, { status: 'erledigt' }];
  assert.deepEqual(boardColumns(['offen', 'erledigt'], ideen), ['offen', 'erledigt']);
  assert.deepEqual(boardColumns(['offen', 'erledigt', 'verworfen'], ideen), ['offen', 'erledigt', 'verworfen']);
});

test('boardColumns: abgeschaltete Stufe mit Ideen bleibt als Spalte stehen — in kanonischer Reihenfolge', () => {
  const ideen = [{ status: 'offen' }, { status: 'in_arbeit' }, { status: 'verworfen' }];
  assert.deepEqual(boardColumns(['offen', 'erledigt'], ideen), ['offen', 'in_arbeit', 'erledigt', 'verworfen']);
});

test('boardColumns: ohne Stufen-Angabe alle vier; kaputter Status zaehlt als offen', () => {
  assert.deepEqual(boardColumns(null, []), ['offen', 'in_arbeit', 'erledigt', 'verworfen']);
  assert.deepEqual(boardColumns(['offen', 'erledigt'], [{ status: 'quatsch' }]), ['offen', 'erledigt']);
});
