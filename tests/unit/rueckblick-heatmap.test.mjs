// Tests für _computeRueckblickHeatmap (book-overview/diary.js): Quartil-
// Bucketing, Jahr-Range, Monats-Lücken als Level 0, Marker-Zuordnung Monat vs.
// Jahr, leere Coverage → leeres Ergebnis. Analog streak-heatmap.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { __app: { uiLocale: 'de' } };
const { bookOverviewMethods: M } = await import('../../public/js/book-overview.js');

test('_computeRueckblickHeatmap: leere/ungültige Coverage → leeres Ergebnis', () => {
  assert.deepEqual(M._computeRueckblickHeatmap(null), { years: [], maxEntries: 0, monthsWithEntries: 0, monthsWithRueckblick: 0 });
  assert.deepEqual(
    M._computeRueckblickHeatmap({ months: {}, years: {}, minYear: null, maxYear: null }),
    { years: [], maxEntries: 0, monthsWithEntries: 0, monthsWithRueckblick: 0 });
});

test('_computeRueckblickHeatmap: Jahr-Range absteigend, je 12 Monate', () => {
  const cov = {
    months: {},
    years: { '2022': { entries: 5, rueckblick: null }, '2024': { entries: 3, rueckblick: null } },
    minYear: 2022, maxYear: 2024,
  };
  const r = M._computeRueckblickHeatmap(cov);
  assert.deepEqual(r.years.map(y => y.year), [2024, 2023, 2022]);
  for (const y of r.years) assert.equal(y.months.length, 12);
});

test('_computeRueckblickHeatmap: Monats-Eintragszahlen → Level-Buckets + leere als 0', () => {
  const months = {
    '2024-01': { entries: 1, rueckblick: null },
    '2024-02': { entries: 5, rueckblick: null },
    '2024-03': { entries: 10, rueckblick: null },
    '2024-04': { entries: 20, rueckblick: null },
  };
  const cov = { months, years: { '2024': { entries: 36, rueckblick: null } }, minYear: 2024, maxYear: 2024 };
  const r = M._computeRueckblickHeatmap(cov);
  assert.equal(r.maxEntries, 20);
  const byKey = {};
  for (const c of r.years[0].months) byKey[c.key] = c.level;
  assert.equal(byKey['2024-05'], 0); // leerer Monat
  const levels = new Set(r.years[0].months.map(c => c.level).filter(l => l > 0));
  assert.ok(levels.size >= 3, `nur ${levels.size} Levels: ${[...levels]}`);
});

test('_computeRueckblickHeatmap: Marker-Zuordnung Monat vs. Jahr', () => {
  const cov = {
    months: { '2024-03': { entries: 4, rueckblick: { id: 7, created_at: '2024-04-01T00:00:00Z' } } },
    years: { '2024': { entries: 4, rueckblick: { id: 9, created_at: '2025-01-01T00:00:00Z' } } },
    minYear: 2024, maxYear: 2024,
  };
  const row = M._computeRueckblickHeatmap(cov).years[0];
  assert.equal(row.hasRueckblick, true);
  assert.equal(row.yearCreatedAt, '2025-01-01T00:00:00Z');
  const march = row.months.find(c => c.key === '2024-03');
  assert.equal(march.hasRueckblick, true);
  assert.equal(march.createdAt, '2024-04-01T00:00:00Z');
  assert.equal(row.months.find(c => c.key === '2024-01').hasRueckblick, false);
});

test('_computeRueckblickHeatmap: verwaister Rückblick (Level 0, aber Marker)', () => {
  const cov = {
    months: { '2020-06': { entries: 0, rueckblick: { id: 1, created_at: '2020-07-01T00:00:00Z' } } },
    years: {},
    minYear: 2020, maxYear: 2020,
  };
  const june = M._computeRueckblickHeatmap(cov).years[0].months.find(c => c.key === '2020-06');
  assert.equal(june.level, 0);
  assert.equal(june.hasRueckblick, true);
});

test('_computeRueckblickHeatmap: Jahr als 13. Zelle in Monats-Form + Zählung', () => {
  const cov = {
    months: {
      '2024-03': { entries: 4, rueckblick: { id: 7, created_at: '2024-04-01T00:00:00Z', stale: true } },
      '2024-05': { entries: 2, rueckblick: null },
      '2023-01': { entries: 9, rueckblick: null },
    },
    years: {
      '2024': { entries: 6, rueckblick: { id: 9, created_at: '2025-01-01T00:00:00Z' } },
      '2023': { entries: 9, rueckblick: null },
    },
    minYear: 2023, maxYear: 2024,
  };
  const r = M._computeRueckblickHeatmap(cov);
  assert.equal(r.monthsWithEntries, 3);
  assert.equal(r.monthsWithRueckblick, 1);
  const y24 = r.years[0].yearCell;
  assert.equal(y24.key, '2024');
  assert.equal(y24.isYear, true);
  assert.equal(y24.entries, 6);
  assert.equal(y24.hasRueckblick, true);
  assert.equal(y24.entryId, 9);
  assert.ok(y24.level > 0);
  const y23 = r.years[1].yearCell;
  assert.equal(y23.hasRueckblick, false);
  assert.equal(y23.hasEntries, true);
  assert.equal(r.years[0].months.find(c => c.key === '2024-03').stale, true);
});
