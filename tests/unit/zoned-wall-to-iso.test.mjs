// Unit tests: utils/date.js#zonedWallToIso — Wanduhr der App-Zone → UTC
// (Planen eines Blog-Beitrags aus einem datetime-local-Feld).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { zonedWallToIso } = await import('../../public/js/utils/date.js');

test('Winterzeit Zuerich: UTC+1', () => {
  assert.equal(zonedWallToIso('2026-01-15T09:30', 'Europe/Zurich'), '2026-01-15T08:30:00.000Z');
});

test('Sommerzeit Zuerich: UTC+2', () => {
  assert.equal(zonedWallToIso('2026-07-01T09:00', 'Europe/Zurich'), '2026-07-01T07:00:00.000Z');
});

test('Tag nach dem DST-Wechsel (29.03.2026)', () => {
  assert.equal(zonedWallToIso('2026-03-29T12:00', 'Europe/Zurich'), '2026-03-29T10:00:00.000Z');
});

test('andere Zone', () => {
  assert.equal(zonedWallToIso('2026-07-01T09:00', 'America/New_York'), '2026-07-01T13:00:00.000Z');
});

test('ungueltig → leer', () => {
  assert.equal(zonedWallToIso('', 'Europe/Zurich'), '');
  assert.equal(zonedWallToIso('morgen', 'Europe/Zurich'), '');
});
