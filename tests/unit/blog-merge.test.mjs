// Unit tests for lib/blog-merge.js: die vier Last-Write-Wins-Faelle des Blog-Pulls.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { newer, latest, syncPoint, classifyPull } = await import('../../lib/blog-merge.js');

test('newer: fehlendes a nie neuer', () => {
  assert.equal(newer('', '2024-01-01T00:00:00.000Z'), false);
  assert.equal(newer(null, '2024-01-01T00:00:00.000Z'), false);
});

test('newer: vorhandenes a, fehlendes b -> a neuer', () => {
  assert.equal(newer('2024-01-01T00:00:00.000Z', ''), true);
  assert.equal(newer('2024-01-01T00:00:00.000Z', null), true);
});

test('newer: ISO-Vergleich', () => {
  assert.equal(newer('2024-02-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'), true);
  assert.equal(newer('2024-01-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z'), false);
  assert.equal(newer('2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z'), false);
});

test('newer: Millisekunden fehlen (Java Instant) -> Zeit, nicht String', () => {
  assert.equal(newer('2024-01-01T10:00:00Z', '2024-01-01T10:00:00.500Z'), false);
  assert.equal(newer('2024-01-01T10:00:01Z', '2024-01-01T10:00:00.500Z'), true);
});

test('newer: zonenloser WordPress-Stamp gilt als UTC', () => {
  assert.equal(newer('2024-01-01T10:00:00', '2024-01-01T09:59:59.000Z'), true);
  assert.equal(newer('2024-01-01T10:00:00', '2024-01-01T10:00:00.001Z'), false);
});

test('classifyPull: kein Link -> create', () => {
  assert.equal(classifyPull({ hasLink: false }), 'create');
});

test('classifyPull: WP neuer, App unveraendert -> update', () => {
  const action = classifyPull({
    hasLink: true,
    wpModifiedAt: '2024-03-01T00:00:00.000Z',
    linkModifiedAt: '2024-02-01T00:00:00.000Z',
    pageUpdatedAt: '2024-02-01T00:00:00.000Z',
    lastPulledAt: '2024-02-15T00:00:00.000Z',
  });
  assert.equal(action, 'update');
});

test('classifyPull: App neuer als letzter Pull, WP unveraendert -> skip (gehoert in Push)', () => {
  const action = classifyPull({
    hasLink: true,
    wpModifiedAt: '2024-02-01T00:00:00.000Z',
    linkModifiedAt: '2024-02-01T00:00:00.000Z',
    pageUpdatedAt: '2024-03-01T00:00:00.000Z',
    lastPulledAt: '2024-02-15T00:00:00.000Z',
  });
  assert.equal(action, 'skip');
});

test('classifyPull: beide Seiten neuer -> conflict', () => {
  const action = classifyPull({
    hasLink: true,
    wpModifiedAt: '2024-03-01T00:00:00.000Z',
    linkModifiedAt: '2024-02-01T00:00:00.000Z',
    pageUpdatedAt: '2024-03-05T00:00:00.000Z',
    lastPulledAt: '2024-02-15T00:00:00.000Z',
  });
  assert.equal(action, 'conflict');
});

test('classifyPull: beide unveraendert -> skip (no-op)', () => {
  const action = classifyPull({
    hasLink: true,
    wpModifiedAt: '2024-02-01T00:00:00.000Z',
    linkModifiedAt: '2024-02-01T00:00:00.000Z',
    pageUpdatedAt: '2024-02-01T00:00:00.000Z',
    lastPulledAt: '2024-02-15T00:00:00.000Z',
  });
  assert.equal(action, 'skip');
});

test('latest/syncPoint: juengerer von Pull und Push', () => {
  assert.equal(latest(null, '', undefined), '');
  assert.equal(latest('2024-01-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z'), '2024-02-01T00:00:00.000Z');
  assert.equal(syncPoint({ last_pulled_at: '2024-03-01T00:00:00.000Z', last_pushed_at: '2024-02-01T00:00:00.000Z' }), '2024-03-01T00:00:00.000Z');
  assert.equal(syncPoint({ last_pulled_at: null, last_pushed_at: '2024-02-01T00:00:00.000Z' }), '2024-02-01T00:00:00.000Z');
});

test('classifyPull: nach Push ist der gepushte Edit kein lokaler Edit mehr', () => {
  const base = {
    hasLink: true, wpModifiedAt: '2024-05-01T00:00:00', linkModifiedAt: '2024-04-01T00:00:00',
    pageUpdatedAt: '2024-04-10T00:00:00.000Z',
  };
  // per Push angelegt: kein Pull-Stamp
  assert.equal(classifyPull({ ...base, lastPulledAt: null, lastPushedAt: '2024-04-10T00:00:01.000Z' }), 'update');
  // Edit → Push → WP-Edit
  assert.equal(classifyPull({ ...base, lastPulledAt: '2024-03-01T00:00:00.000Z', lastPushedAt: '2024-04-10T00:00:01.000Z' }), 'update');
  // Edit NACH dem Push bleibt ein Konflikt
  assert.equal(classifyPull({ ...base, lastPulledAt: null, lastPushedAt: '2024-04-09T00:00:00.000Z' }), 'conflict');
});

test('classifyPull: Titel-Werkstatt-Edit zaehlt als lokaler Edit', () => {
  assert.equal(classifyPull({
    hasLink: true, wpModifiedAt: '2024-05-01T00:00:00', linkModifiedAt: '2024-04-01T00:00:00',
    pageUpdatedAt: '2024-03-01T00:00:00.000Z', headlineUpdatedAt: '2024-04-20T00:00:00.000Z',
    lastPulledAt: '2024-04-01T00:00:00.000Z',
  }), 'conflict');
});
