// Kalendertag-SSoT (public/js/utils/iso-day.js) + Label eines ISO-Tags
// (utils/date.js#formatIsoDay). Ein Tag bleibt derselbe Tag, auch wenn
// Browser-TZ und appTimezone mehr als 12 h auseinanderliegen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

globalThis.window = globalThis.window || {};
const utils = await import('../../public/js/utils.js');
const isoDay = await import('../../public/js/utils/iso-day.js');
const series = await import('../../public/js/cards/my-stats-compute/series.js');

test('eine Implementierung: utils, my-stats und Buch-Uebersicht teilen dieselben Funktionen', () => {
  assert.equal(utils.isoAddDays, isoDay.isoAddDays);
  assert.equal(series.isoAddDays, isoDay.isoAddDays);
  assert.equal(series.isoDaysBetween, isoDay.isoDaysBetween);
  assert.equal(series.isoWeekdayMon, isoDay.isoWeekdayMon);
});

test('isoWeekdayMon: Montag = 0, Sonntag = 6, ungueltig = NaN', () => {
  assert.equal(isoDay.isoWeekdayMon('2024-01-01'), 0);
  assert.equal(isoDay.isoWeekdayMon('2026-10-11'), 6);
  assert.ok(Number.isNaN(isoDay.isoWeekdayMon('kaputt')));
});

test('isoDaysBetween akzeptiert Zeitstempel-Praefix (Snapshot recorded_at)', () => {
  assert.equal(isoDay.isoDaysBetween('2026-01-01T23:59:00Z', '2026-01-03'), 2);
});

// Kindprozess, weil TZ beim Prozessstart greift.
function runInTz(browserTz, appTz) {
  const date = new URL('../../public/js/utils/date.js', import.meta.url).href;
  const script = `
    globalThis.window = {};
    const d = await import(${JSON.stringify(date)});
    d.configureAppTimezone(${JSON.stringify(appTz)});
    const opts = { day: '2-digit', month: '2-digit', year: 'numeric' };
    const naive = d.dateTimeFormat('de', opts).format(new Date('2026-03-28T12:00:00'));
    const utcNoonAppTz = d.dateTimeFormat('de', opts).format(new Date('2026-03-28T12:00:00Z'));
    console.log(JSON.stringify({
      label: d.formatIsoDay('2026-03-28', 'de', opts),
      weekday: d.formatIsoDay('2026-03-28', 'en', { weekday: 'long' }),
      bad: d.formatIsoDay('kaputt', 'de'),
      naive, utcNoonAppTz,
    }));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, TZ: browserTz }, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

test('formatIsoDay: Browser UTC−11, App UTC+14 — derselbe Kalendertag', () => {
  const r = runInTz('Pacific/Pago_Pago', 'Pacific/Kiritimati');
  assert.equal(r.label, '28.03.2026');
  assert.equal(r.weekday, 'Saturday');
  assert.equal(r.bad, '');
  // Gegenprobe: die ersetzten Anker kippen in dieser Konstellation.
  assert.notEqual(r.naive, '28.03.2026');
  assert.notEqual(r.utcNoonAppTz, '28.03.2026');
});

test('formatIsoDay: Browser UTC+14, App UTC−11 — derselbe Kalendertag', () => {
  const r = runInTz('Pacific/Kiritimati', 'Pacific/Pago_Pago');
  assert.equal(r.label, '28.03.2026');
  assert.notEqual(r.naive, '28.03.2026');
});
