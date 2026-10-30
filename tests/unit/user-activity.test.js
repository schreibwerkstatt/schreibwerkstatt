'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { requestSignalsActivity, makeActivityCounter, ACTIVITY_GAP_MS } = require('../../lib/user-activity');

function req({ header = null, via = null, method = 'GET' } = {}) {
  return {
    method,
    get: (h) => (h === 'x-user-active' ? header : undefined),
    session: { user: { email: 'a@x', ...(via ? { via } : {}) } },
  };
}

test('Signal: Browser nur mit X-User-Active, Device-Token nur schreibend', () => {
  assert.equal(requestSignalsActivity(req()), false);
  assert.equal(requestSignalsActivity(req({ header: '1' })), true);
  assert.equal(requestSignalsActivity(req({ method: 'POST' })), false);
  assert.equal(requestSignalsActivity(req({ via: 'device_token' })), false);
  assert.equal(requestSignalsActivity(req({ via: 'device_token', method: 'PUT' })), true);
});

test('Zähler: pro User, nicht pro Session — zwei Geräte buchen dieselbe Zeit nicht doppelt', () => {
  const booked = [];
  const record = makeActivityCounter({ add: (e, s) => booked.push([e, s]) });
  const t0 = 1_000_000;
  // Gerät A und B wechseln sich alle 30 s ab, über 2 Minuten.
  for (let i = 0; i <= 4; i++) record('a@x', t0 + i * 30_000);
  const total = booked.reduce((s, [, sec]) => s + sec, 0);
  assert.equal(total, 120);
});

test('Zähler: Lücke ab Gap bucht nichts, Users getrennt', () => {
  const booked = [];
  const record = makeActivityCounter({ add: (e, s) => booked.push([e, s]) });
  const t0 = 5_000_000;
  record('a@x', t0);
  record('b@x', t0 + 10_000);
  record('a@x', t0 + ACTIVITY_GAP_MS);
  assert.deepEqual(booked, []); // je erstes Signal bucht nichts, a: Lücke = Gap
  record('b@x', t0 + 40_000);
  assert.deepEqual(booked, [['b@x', 30]]);
});
