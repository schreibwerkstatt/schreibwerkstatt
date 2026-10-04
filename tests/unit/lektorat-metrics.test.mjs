import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeLektoratMetrics } = require('../../lib/lektorat-metrics.js');

const F = (typ, original) => ({ typ, original, korrektur: '', erklaerung: '' });
const errs = (...fs) => JSON.stringify(fs);

test('leere Eingabe → alle Modi 0', () => {
  const m = computeLektoratMetrics([]);
  assert.deepEqual(m, {
    open: { total: 0, byTyp: {} },
    applied: { total: 0, byTyp: {} },
    all: { total: 0, byTyp: {} },
  });
  assert.deepEqual(computeLektoratMetrics(null).all, { total: 0, byTyp: {} });
});

test('nur jüngster Check pro Seite zählt (checked_at max)', () => {
  const rows = [
    { page_id: 1, checked_at: '2026-01-01T10:00:00.000Z', errors_json: errs(F('stil', 'a'), F('stil', 'b')), applied_errors_json: null },
    { page_id: 1, checked_at: '2026-01-02T10:00:00.000Z', errors_json: errs(F('grammatik', 'c')), applied_errors_json: null },
  ];
  const m = computeLektoratMetrics(rows);
  // Der jüngere Check (grammatik/c) gewinnt für open/all.
  assert.equal(m.all.total, 1);
  assert.deepEqual(m.all.byTyp, { grammatik: 1 });
  assert.equal(m.open.total, 1);
});

test('applied vereinigt über ALLE Checks der Seite; open zieht nur Annahmen ab, die den jüngsten Stand betreffen', () => {
  const rows = [
    // Älterer Check: 'a' angenommen und gespeichert, BEVOR neu lektoriert wurde.
    { page_id: 7, checked_at: '2026-03-01T09:00:00.000Z', saved_at: '2026-03-01T10:00:00.000Z', errors_json: errs(F('stil', 'a')), applied_errors_json: errs(F('stil', 'a')) },
    // Jüngster Check: meldet 'a' erneut (weiteres Vorkommen) + 'b'; 'b' hier angenommen.
    { page_id: 7, checked_at: '2026-03-05T09:00:00.000Z', saved_at: '2026-03-05T09:30:00.000Z', errors_json: errs(F('stil', 'a'), F('grammatik', 'b')), applied_errors_json: errs(F('grammatik', 'b')) },
  ];
  const m = computeLektoratMetrics(rows);
  assert.equal(m.all.total, 2);
  // applied = Union über alle Checks = { stil:a, grammatik:b }
  assert.deepEqual(m.applied.byTyp, { stil: 1, grammatik: 1 });
  // open: 'b' ist im jüngsten Lauf angenommen, 'a' stammt aus dem Text, den der
  // jüngste Lauf schon korrigiert gesehen hat → bleibt offen.
  assert.deepEqual(m.open.byTyp, { stil: 1 });
});

test('words_checked: Wörter der geprüften Seiten, nur mit wordsByPage', () => {
  const rows = [
    { page_id: 1, checked_at: '2026-01-01T00:00:00.000Z', errors_json: errs(F('stil', 'a')), applied_errors_json: null },
    { page_id: 3, checked_at: '2026-01-01T00:00:00.000Z', errors_json: errs(), applied_errors_json: null },
  ];
  // Seite 2 ist ungeprüft, Seite 3 existiert in der Fassung nicht mehr.
  const wordsByPage = new Map([[1, 400], [2, 600]]);
  assert.equal(computeLektoratMetrics(rows, { wordsByPage }).words_checked, 400);
  assert.equal(computeLektoratMetrics(rows).words_checked, undefined);
});

test('Findings ohne typ werden nicht gezählt', () => {
  const rows = [
    { page_id: 3, checked_at: '2026-01-01T00:00:00.000Z', errors_json: JSON.stringify([{ original: 'x' }, F('stil', 'y')]), applied_errors_json: null },
  ];
  const m = computeLektoratMetrics(rows);
  assert.equal(m.all.total, 1);
  assert.deepEqual(m.all.byTyp, { stil: 1 });
});

test('defektes JSON → als leer behandelt (kein Wurf)', () => {
  const rows = [
    { page_id: 5, checked_at: '2026-01-01T00:00:00.000Z', errors_json: '{kaputt', applied_errors_json: 'auch kaputt' },
  ];
  const m = computeLektoratMetrics(rows);
  assert.equal(m.all.total, 0);
  assert.equal(m.open.total, 0);
});

test('mehrere Seiten aggregieren nach Typ', () => {
  const rows = [
    { page_id: 1, checked_at: '2026-01-01T00:00:00.000Z', errors_json: errs(F('stil', 'a'), F('grammatik', 'b')), applied_errors_json: null },
    { page_id: 2, checked_at: '2026-01-01T00:00:00.000Z', errors_json: errs(F('stil', 'c')), applied_errors_json: null },
  ];
  const m = computeLektoratMetrics(rows);
  assert.equal(m.open.total, 3);
  assert.deepEqual(m.open.byTyp, { stil: 2, grammatik: 1 });
});

test('Fassungs-Kennzahl und Live-Heatmap zählen identisch (gemeinsamer Kern)', async () => {
  // Der Fehlerdichte-Trend steht neben der Heatmap; zählten beide verschieden,
  // widerspräche die jüngste Fassung der Matrix darüber.
  const { buildFehlerHeatmap } = await import('../../lib/fehler-heatmap.js');
  const rows = [
    { id: 1, page_id: 1, checked_at: '2026-03-01T09:00:00.000Z', saved_at: '2026-03-06T08:00:00.000Z', errors_json: errs(F('stil', 'a')), applied_errors_json: errs(F('stil', 'a')) },
    { id: 2, page_id: 1, checked_at: '2026-03-05T09:00:00.000Z', saved_at: null, errors_json: errs(F('stil', 'a'), F('stil', 'a'), F('grammatik', 'b'), { typ: 'stil' }), applied_errors_json: null },
    { id: 3, page_id: 2, checked_at: '2026-03-05T09:00:00.000Z', saved_at: '2026-03-05T09:10:00.000Z', errors_json: errs(F('fuellwort', 'halt')), applied_errors_json: errs(F('fuellwort', 'halt')) },
  ];
  const m = computeLektoratMetrics(rows);
  const latest = [rows[1], rows[2]];
  const appliedRows = rows.filter(r => r.applied_errors_json);
  for (const mode of ['open', 'applied', 'all']) {
    const h = buildFehlerHeatmap({
      pages: [{ page_id: 1, chapter_id: 1, words: 100 }, { page_id: 2, chapter_id: 1, words: 100 }],
      checks: latest, appliedRows, mode,
    });
    const total = Object.values(h.totals).reduce((s, n) => s + n, 0);
    assert.equal(total, m[mode].total, `Modus ${mode}`);
  }
});
