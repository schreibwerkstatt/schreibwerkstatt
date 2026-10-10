// Kalendertag-Arithmetik der Buch-Uebersicht (public/js/book-overview/iso-day.js)
// und die Vollstaendigkeits-Regel des Live-Stands (utils/format.js#
// completeLiveBookStats), auf der Hero, Heute-Ring, 7-Tage-Bilanz und
// Schreibziel-Prognose stehen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isoAddDays, isoDaysBetween, isoWeekday, isoLastDays, isoNoonUtc } from '../../public/js/book-overview/iso-day.js';
import { completeLiveBookStats } from '../../public/js/utils.js';
import { computeTodayRing, makeDayDelta } from '../../public/js/today-ring.js';

test('isoAddDays: Monats-/Jahres-/Schaltjahrgrenzen', () => {
  assert.equal(isoAddDays('2026-03-01', -1), '2026-02-28');
  assert.equal(isoAddDays('2024-03-01', -1), '2024-02-29');
  assert.equal(isoAddDays('2025-12-31', 1), '2026-01-01');
  assert.equal(isoAddDays('2026-07-04', 0), '2026-07-04');
});

test('isoAddDays: DST-Umstellungstage verschieben nichts', () => {
  // Europa: 29.03.2026 (vor) und 25.10.2026 (zurück).
  assert.equal(isoAddDays('2026-03-30', -1), '2026-03-29');
  assert.equal(isoAddDays('2026-03-29', -1), '2026-03-28');
  assert.equal(isoAddDays('2026-10-26', -1), '2026-10-25');
  assert.equal(isoDaysBetween('2026-03-28', '2026-03-30'), 2);
});

test('isoDaysBetween: Vorzeichen und ungültige Eingabe', () => {
  assert.equal(isoDaysBetween('2026-07-01', '2026-07-04'), 3);
  assert.equal(isoDaysBetween('2026-07-04', '2026-07-01'), -3);
  assert.ok(Number.isNaN(isoDaysBetween('kaputt', '2026-07-01')));
  assert.equal(isoNoonUtc('kein Datum'), null);
});

test('isoWeekday: unabhängig von der Browser-Zeitzone', () => {
  assert.equal(isoWeekday('2024-01-01'), 1, 'Montag');
  assert.equal(isoWeekday('2026-10-11'), 0, 'Sonntag');
});

test('isoLastDays: ältester zuerst, heute zuletzt', () => {
  assert.deepEqual(isoLastDays('2026-01-02', 4), ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']);
});

test('completeLiveBookStats: nur bei vollständiger Abdeckung aller Seiten', () => {
  const ts = { 1: { chars: 100, words: 20, tok: 25 }, 2: { chars: 50, words: 10, tok: 12 } };
  assert.deepEqual(completeLiveBookStats(ts, [{ id: 1 }, { id: 2 }]), { chars: 150, words: 30, tok: 37 });
  assert.equal(completeLiveBookStats(ts, [{ id: 1 }, { id: 2 }, { id: 3 }]), null, 'Seite 3 fehlt');
  assert.equal(completeLiveBookStats({}, []), null, 'Buch ohne Seiten');
});

test('completeLiveBookStats: Einträge gelöschter Seiten zählen nicht', () => {
  const ts = { 1: { chars: 100 }, 99: { chars: 5000 } };
  assert.equal(completeLiveBookStats(ts, [{ id: 1 }]).chars, 100);
});

test('completeLiveBookStats: ohne Seitenliste gilt eine positive Summe', () => {
  assert.equal(completeLiveBookStats({ 1: { chars: 10 } }).chars, 10);
  assert.equal(completeLiveBookStats({ 1: { chars: 0 } }), null);
});

test('Heute-Ring (Header-Pfad): Teil-tokEsts fallen auf den Snapshot statt Minus-Tag', () => {
  const stats = [
    { recorded_at: '2026-07-03', chars: 10000 },
    { recorded_at: '2026-07-04', chars: 10400 },
  ];
  const pages = [{ id: 1 }, { id: 2 }];
  const partial = { 1: { chars: 3000 } };
  const ring = computeTodayRing({ stats, tokEsts: partial, pages, todayIso: '2026-07-04', goalChars: 1500 });
  assert.equal(ring.chars, 400, 'heutiger Snapshot minus Vortag');
  const dd = makeDayDelta({ stats, tokEsts: partial, pages, todayIso: '2026-07-04' });
  assert.equal(dd('2026-07-04'), 400);
  const full = { 1: { chars: 3000 }, 2: { chars: 7600 } };
  assert.equal(makeDayDelta({ stats, tokEsts: full, pages, todayIso: '2026-07-04' })('2026-07-04'), 600);
});

test('Heute-Ring: neues Buch nur auf ausdrückliche Anforderung gegen 0', () => {
  const pages = [{ id: 1 }];
  const ts = { 1: { chars: 900 } };
  assert.equal(computeTodayRing({ stats: [], tokEsts: ts, pages, todayIso: '2026-07-04' }).chars, 0);
  assert.equal(computeTodayRing({ stats: [], tokEsts: ts, pages, todayIso: '2026-07-04', newBookBaseline: true }).chars, 900);
  assert.equal(computeTodayRing({ stats: [], tokEsts: {}, pages, todayIso: '2026-07-04', newBookBaseline: true }).chars, 0,
    'unvollständiger Live-Stand → nichts');
});
