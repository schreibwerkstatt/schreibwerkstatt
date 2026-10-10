// Server-Helper-Pendant zu local-date.test.mjs. CommonJS, weil lib/local-date.js
// require()'d wird (sync.js, history.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { localIsoDate, localIsoDaysAgo, localMonthStartIso, localMonthPeriod, currentTz } = require('../../lib/local-date.js');

test('server localIsoDate: Format YYYY-MM-DD', () => {
  const iso = localIsoDate();
  assert.match(iso, /^\d{4}-\d{2}-\d{2}$/);
});

test('server localIsoDate: respektiert TZ-Override', () => {
  const d = new Date('2026-05-04T22:00:00Z'); // UTC Mo 22:00 = CEST Di 00:00
  // In Europe/Zurich ist es bereits Di 04.05+1
  const zurich = localIsoDate(d, 'Europe/Zurich');
  // In UTC ist es noch Mo 04.05.
  const utc = localIsoDate(d, 'UTC');
  assert.equal(utc, '2026-05-04');
  assert.equal(zurich, '2026-05-05');
});

test('server localIsoDaysAgo: chronologisch + DST-stabil', () => {
  const today = localIsoDaysAgo(0);
  const dates = new Set();
  for (let i = 0; i < 60; i++) dates.add(localIsoDaysAgo(i));
  assert.equal(dates.size, 60);
  assert.ok(dates.has(today));
});

test('server localIsoDaysAgo: Anker ist das tz-Datum, nicht die Prozess-Zeitzone', () => {
  // 00:30 in Zuerich am 11.10. = 22:30 UTC am 10.10.
  const base = new Date('2026-10-10T22:30:00Z');
  assert.equal(localIsoDate(base, 'Europe/Zurich'), '2026-10-11');
  assert.equal(localIsoDaysAgo(0, base, 'Europe/Zurich'), '2026-10-11');
  assert.equal(localIsoDaysAgo(1, base, 'Europe/Zurich'), '2026-10-10');
  // DST-Ende (25.10.2026): 24-h-Schritte duerfen keinen Tag doppelt treffen.
  const dst = new Date('2026-10-26T10:00:00Z');
  assert.equal(localIsoDaysAgo(1, dst, 'Europe/Zurich'), '2026-10-25');
  assert.equal(localIsoDaysAgo(2, dst, 'Europe/Zurich'), '2026-10-24');
});

test('server currentTz: app_settings-aware Fallback', () => {
  const tz = currentTz();
  assert.ok(typeof tz === 'string' && tz.length > 0);
});

test('localMonthStartIso: 1. des Monats 00:00 in tz, als UTC-Instant', () => {
  // 1. Mai 2026 00:00 in Europe/Zurich (CEST, +02:00) = 30. April 22:00 UTC.
  const d = new Date('2026-05-15T12:00:00Z');
  assert.equal(localMonthStartIso(d, 'Europe/Zurich'), '2026-04-30T22:00:00.000Z');
  // In UTC ist Monatsbeginn exakt der 1. um 00:00 UTC.
  assert.equal(localMonthStartIso(d, 'UTC'), '2026-05-01T00:00:00.000Z');
  // Edge: erste Stunden des Monats lokal, aber UTC noch im Vormonat.
  const edge = new Date('2026-05-01T00:30:00Z'); // CEST: 02:30 am 1.5.
  assert.equal(localMonthStartIso(edge, 'Europe/Zurich'), '2026-04-30T22:00:00.000Z');
});

test('localMonthStartIso: TZ-Boundary kippt Monatsbucket', () => {
  // UTC 30.04 22:00 → Zurich 1.5 00:00 → Zurich-Monat = Mai
  const d = new Date('2026-04-30T22:30:00Z');
  assert.equal(localMonthStartIso(d, 'Europe/Zurich'), '2026-04-30T22:00:00.000Z');
  // Selbe Instant in UTC = April-Monat
  assert.equal(localMonthStartIso(d, 'UTC'), '2026-04-01T00:00:00.000Z');
});

test('localMonthPeriod: YYYY-MM in tz', () => {
  const d = new Date('2026-04-30T22:30:00Z');
  assert.equal(localMonthPeriod(d, 'Europe/Zurich'), '2026-05');
  assert.equal(localMonthPeriod(d, 'UTC'), '2026-04');
});
