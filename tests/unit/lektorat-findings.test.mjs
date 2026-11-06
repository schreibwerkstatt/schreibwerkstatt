// Zaehlregel der Lektorat-Befunde (lib/lektorat-findings.js): offen/angenommen/
// gemeldet pro Seite und die Ordnung „juengster Check". Gemeinsamer Kern von
// Fehler-Heatmap und Fehlerdichte-Trend — eine Abweichung hier verrechnet beide.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pageFindings, compareChecks, latestCheck } = require('../../lib/lektorat-findings.js');

const F = (typ, original) => ({ typ, original });
const js = (...f) => JSON.stringify(f);

test('applied zaehlt innerhalb eines Laufs jedes angenommene Vorkommen', () => {
  // Zwei „ploetzlich" gemeldet, beide uebernommen: offen 0, angenommen 2 —
  // offen + angenommen = gemeldet.
  const latest = { id: 1, checked_at: '2026-01-01T00:00:00.000Z',
    errors_json: js(F('fuellwort', 'ploetzlich'), F('fuellwort', 'ploetzlich')),
    applied_errors_json: js(F('fuellwort', 'ploetzlich'), F('fuellwort', 'ploetzlich')) };
  const r = pageFindings(latest, [latest]);
  assert.equal(r.open.length, 0);
  assert.equal(r.applied.length, 2);
  assert.equal(r.all.length, 2);
});

test('applied ueber Laeufe: dieselbe Annahme zaehlt nicht doppelt, der groesste Lauf gewinnt', () => {
  const rows = [
    { id: 1, checked_at: '2026-01-01T00:00:00.000Z', applied_errors_json: js(F('stil', 'A')) },
    { id: 2, checked_at: '2026-01-02T00:00:00.000Z', applied_errors_json: js(F('grammatik', 'A'), F('grammatik', 'A')) },
  ];
  const latest = { id: 3, checked_at: '2026-01-03T00:00:00.000Z', errors_json: js() };
  const r = pageFindings(latest, rows);
  assert.equal(r.applied.length, 2, 'max(1, 2), nicht 1 + 2');
  assert.equal(r.applied[0].typ, 'stil', 'erster Eintrag bleibt der aeltere Lauf (stabiler typ)');
});

test('compareChecks: Zeit, bei Gleichstand id', () => {
  const a = { id: 1, checked_at: '2026-01-01T00:00:00.000Z' };
  const b = { id: 2, checked_at: '2026-01-01T00:00:00.000Z' };
  const c = { id: 0, checked_at: '2026-01-02T00:00:00.000Z' };
  assert.ok(compareChecks(a, b) < 0);
  assert.ok(compareChecks(c, b) > 0);
  assert.equal(latestCheck([a, c, b]), c);
  assert.equal(latestCheck([b, a]), b, 'gleiche Zeit → groessere id');
  assert.equal(latestCheck([]), null);
});
