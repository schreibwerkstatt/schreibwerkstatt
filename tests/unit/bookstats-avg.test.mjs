// Ø-Auswertung der Buchentwicklungs-Kurve (public/js/book/bookstats-avg.js).
// Die Kennzahlen unter dem Diagramm und die Overlay-Serien haengen an diesen
// Funktionen; ein stiller Rechenfehler faellt im UI nicht auf, weil jede Zahl
// plausibel aussieht.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CLASSIFIED_METRICS, bucketFor, bucketSeries, bucketStart, computeAvgSummary, fillCalendar,
  metricKind, rollingSeries, rollingWindowForRange, tempoRows, trendSeries,
} from '../../public/js/book/bookstats-avg.js';

const near = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: ${actual} != ${expected}`);

test('jede Chart-Metrik ist einer Art zugeordnet (Drift-Guard)', () => {
  const src = readFileSync(new URL('../../public/js/book/bookstats.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('const METRIC_KEYS = {'), src.indexOf('};', src.indexOf('const METRIC_KEYS = {')));
  const keys = [...block.matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]);
  assert.ok(keys.length >= 19, `METRIC_KEYS nicht gefunden (${keys.length})`);
  for (const k of keys) {
    assert.ok(CLASSIFIED_METRICS.has(k), `Metrik "${k}" ist in bookstats-avg.js nicht eingeordnet`);
  }
});

test('metricKind trennt Bestand, Tagesmenge und Verhaeltniszahl', () => {
  assert.equal(metricKind('chars'), 'stock');
  assert.equal(metricKind('writing_cumulative'), 'stock');
  assert.equal(metricKind('delta_words'), 'flow');
  assert.equal(metricKind('stt_minutes'), 'flow');
  assert.equal(metricKind('avg_lix'), 'rate');
});

test('Tagesmenge: Ø pro KALENDERTAG, nicht pro Messpunkt', () => {
  // 01., 03., 08. September — 8 Kalendertage Spanne, 3 aktive Tage.
  const s = computeAvgSummary({
    metric: 'delta_chars',
    dates: ['2026-09-01', '2026-09-03', '2026-09-08'],
    values: [10, 20, 30],
  });
  assert.equal(s.kind, 'flow');
  assert.equal(s.spanDays, 8);
  assert.equal(s.activeDays, 3);
  assert.equal(s.total, 60);
  near(s.perDay, 7.5, 'perDay');
  near(s.perWeek, 52.5, 'perWeek');
  near(s.perMonth, 225, 'perMonth');
  near(s.mean, 20, 'mean (je aktivem Tag)');
});

test('Bestandsgroesse: Ø-ZUWACHS pro Tag/Woche/Monat', () => {
  const s = computeAvgSummary({
    metric: 'chars',
    dates: ['2026-09-01', '2026-09-11'],
    values: [1000, 3000],
  });
  assert.equal(s.kind, 'stock');
  assert.equal(s.delta, 2000);
  assert.equal(s.elapsedDays, 10);
  near(s.perDay, 200, 'perDay');
  near(s.perWeek, 1400, 'perWeek');
  near(s.perMonth, 6000, 'perMonth');
  assert.equal(s.level, 3000);
});

test('Bestandsgroesse mit nur einem Messpunkt: kein Zuwachs, kein NaN', () => {
  const s = computeAvgSummary({ metric: 'words', dates: ['2026-09-01'], values: [500] });
  assert.equal(s.perDay, 0);
  assert.equal(s.spanDays, 1);
});

test('Verhaeltniszahl: Ø-Wert der Messpunkte', () => {
  const s = computeAvgSummary({
    metric: 'avg_sentence_len',
    dates: ['2026-09-01', '2026-09-02', '2026-09-03'],
    values: [3, 5, 7],
  });
  assert.equal(s.kind, 'rate');
  near(s.perDay, 5, 'Ø-Niveau');
});

test('fuehrende Luecken zaehlen nicht zur Spanne', () => {
  const s = computeAvgSummary({
    metric: 'delta_words',
    dates: ['2026-09-01', '2026-09-02', '2026-09-03'],
    values: [null, 10, 20],
  });
  assert.equal(s.from, '2026-09-02');
  assert.equal(s.spanDays, 2);
  near(s.perDay, 15, 'perDay ab erstem echten Punkt');
});

test('leere Serie liefert null statt NaN-Badges', () => {
  assert.equal(computeAvgSummary({ metric: 'chars', dates: ['2026-09-01'], values: [null] }), null);
});

test('gleitender Ø rechnet ueber Kalendertage, nicht ueber Punkte', () => {
  const dates = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-05'];
  const values = [6, 0, 3, 9];
  // perDay: Summe des 3-Tage-Fensters / abgedeckte Kalendertage.
  assert.deepEqual(rollingSeries(dates, values, 3, { perDay: true }), [6, 3, 3, 4]);
  // ohne perDay: Mittel der Punkte im Fenster (05.09. sieht nur 03. und 05.).
  assert.deepEqual(rollingSeries(dates, values, 3), [6, 3, 3, 6]);
});

test('gleitender Ø bleibt vor dem ersten Messpunkt leer', () => {
  const out = rollingSeries(['2026-09-01', '2026-09-02'], [null, 4], 3, { perDay: true });
  assert.equal(out[0], null);
  near(out[1], 4, 'erster echter Punkt');
});

test('Ø-Entwicklung interpoliert nach Datum, nicht nach Index', () => {
  const out = trendSeries(['2026-09-01', '2026-09-03', '2026-09-06'], [10, 99, 40]);
  assert.deepEqual(out, [10, 22, 40]);
});

test('Ø-Entwicklung braucht zwei Messpunkte', () => {
  assert.deepEqual(trendSeries(['2026-09-01'], [10]), [null]);
});

test('Fensterbreite folgt dem gewaehlten Zeitraum', () => {
  assert.equal(rollingWindowForRange(7), 3);
  assert.equal(rollingWindowForRange(30), 7);
  assert.equal(rollingWindowForRange(90), 7);
  assert.equal(rollingWindowForRange(365), 30);
  assert.equal(rollingWindowForRange(0), 30);
});

test('Kalender: Tagesmengen bekommen Null-Tage, Bestaende bleiben leer', () => {
  const flow = fillCalendar(['2026-09-01', '2026-09-04'], [5, 7], 'flow');
  assert.deepEqual(flow.dates, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
  assert.deepEqual(flow.values, [5, 0, 0, 7]);
  const stock = fillCalendar(['2026-09-01', '2026-09-03'], [100, 120], 'stock');
  assert.deepEqual(stock.values, [100, null, 120]);
});

test('Tagesmenge: aufgefuellte Null-Tage sind keine aktiven Tage', () => {
  const cal = fillCalendar(['2026-09-01', '2026-09-08'], [10, 30], 'flow');
  const s = computeAvgSummary({ kind: 'flow', dates: cal.dates, values: cal.values });
  assert.equal(s.spanDays, 8);
  assert.equal(s.activeDays, 2);
  near(s.perDay, 5, 'perDay ueber den Kalender');
  near(s.mean, 20, 'Ø je aktivem Tag');
});

test('Verdichtung folgt Zeitraum und Spanne', () => {
  assert.equal(bucketFor(90, 90), 'day');
  assert.equal(bucketFor(365, 60), 'day', 'junges Buch bleibt tageweise');
  assert.equal(bucketFor(365, 365), 'week');
  assert.equal(bucketFor(0, 100), 'day');
  assert.equal(bucketFor(0, 300), 'week');
  assert.equal(bucketFor(0, 700), 'month');
});

test('Wochen beginnen montags, Monate am Ersten', () => {
  assert.equal(bucketStart('2026-11-01', 'week'), '2026-10-26'); // Sonntag → Montag davor
  assert.equal(bucketStart('2026-10-26', 'week'), '2026-10-26');
  assert.equal(bucketStart('2026-10-17', 'month'), '2026-10-01');
});

test('Eimer: Summe, letzter Stand, Mittel — mit Randtagen', () => {
  const dates = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'];
  const flow = bucketSeries(dates, [1, 2, 3, 4], 'flow', 'week');
  assert.deepEqual(flow.map(b => [b.start, b.days, b.value]), [['2026-10-26', 3, 6], ['2026-11-02', 1, 4]]);
  const stock = bucketSeries(dates, [10, null, 30, 40], 'stock', 'month');
  assert.deepEqual(stock.map(b => [b.start, b.end, b.value]), [['2026-10-01', '2026-10-31', 10], ['2026-11-01', '2026-11-02', 40]]);
  const rate = bucketSeries(dates, [2, 4, null, null], 'rate', 'month');
  assert.deepEqual(rate.map(b => b.value), [3, null]);
});

test('Schreibtempo: Σ Zeichen / Σ Stunden, ohne Import und ohne Kurz-Tage', () => {
  const stats = [
    { recorded_at: '2026-10-01', chars: 1000, imported_chars: 0 },
    { recorded_at: '2026-10-02', chars: 3000, imported_chars: 0 },     // +2000 in 1 h
    { recorded_at: '2026-10-03', chars: 13000, imported_chars: 9000 }, // +1000 geschrieben in 0,5 h
    { recorded_at: '2026-10-04', chars: 16000, imported_chars: 9000 }, // 2 min: zählt nicht
  ];
  const writing = [
    { date: '2026-10-02', seconds: 3600 }, { date: '2026-10-03', seconds: 1800 }, { date: '2026-10-04', seconds: 120 },
  ];
  const rows = tempoRows(stats, writing);
  assert.deepEqual(rows.map(r => r.cph), [2000, 2000, null]);
  const s = computeAvgSummary({
    kind: 'rate', dates: rows.map(r => r.recorded_at), values: rows.map(r => r.cph), weights: rows.map(r => r.hours),
  });
  near(s.perDay, 2000, 'gewogener Ø');
});

test('gewogener Ø: lange Tage zaehlen mehr als kurze', () => {
  const s = computeAvgSummary({ kind: 'rate', dates: ['2026-10-01', '2026-10-02'], values: [1000, 4000], weights: [3, 1] });
  near(s.perDay, 1750, 'Σ(v·w)/Σw');
});
