// Gate fuer die Kapitel-Entstehung ("Entwicklung"-Kachel im Kapitel-Dashboard).
//
// WARUM ALS UNIT-TEST: Die Kachel behauptet einen Verlauf, den niemand
// gegenpruefen kann — wer weiss noch, wie gross Kapitel 7 im Maerz war? Ein
// stiller Rechenfehler faellt darum nicht auf. Die Fassungs-Historie ist
// ausserdem geloescht-und-ausgeduennt (pruneTiered), im Betrieb also nie im
// Zustand, in dem man sie von Hand nachrechnen wuerde.
//
// DIE INVARIANTEN:
//   1. Punkte sind ABSOLUTE Staende, nicht Zuwaechse — sonst faellt jede Seite,
//      die an einem Tag nicht angefasst wurde, stillschweigend auf null.
//   2. Mehrere Kapitel eines Scopes werden fortgeschrieben summiert.
//   3. Seiten ohne Fassungs-Historie sind UNVERAENDERT, nicht leer: sie zaehlen
//      als konstanter Sockel (sonst sieht das Kapitel kleiner aus als es ist).
//   4. Der rechte Rand ist der Live-Stand — er muss zur Umfang-Kachel daneben
//      passen, die im selben Raster steht.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  computeGrowth, mergeScopeSeries, bucketSeries, growthGeometry, isoDiffDays, isoAddDays,
} from '../../public/js/cards/kapitel-growth.js';

const require = createRequire(import.meta.url);
const { buildChapterGrowth } = require('../../lib/chapter-growth.js');

const rev = (chapter_id, page_id, created_at, chars, words = Math.round(chars / 6)) =>
  ({ chapter_id, page_id, created_at, chars, words });

// ── Server: Fassungs-Zeilen → Zeitreihe je Kapitel ──────────────────────────

test('buildChapterGrowth: Punkte sind absolute Kapitel-Staende', () => {
  const { chapters } = buildChapterGrowth([
    rev(1, 10, '2026-03-01T09:00:00.000Z', 100),
    rev(1, 11, '2026-03-01T10:00:00.000Z', 50),
    rev(1, 10, '2026-03-05T09:00:00.000Z', 400),
  ], { tz: 'Europe/Zurich' });

  assert.deepEqual(chapters['1'].points.map(p => [p.d, p.c]), [
    ['2026-03-01', 150],   // beide Seiten, nicht nur die zuletzt gespeicherte
    ['2026-03-05', 450],   // Seite 11 laeuft unveraendert mit
  ]);
  assert.deepEqual(chapters['1'].pages.sort(), [10, 11]);
});

test('buildChapterGrowth: mehrere Fassungen am selben Tag ergeben EINEN Punkt (den letzten)', () => {
  const { chapters } = buildChapterGrowth([
    rev(1, 10, '2026-03-01T09:00:00.000Z', 100),
    rev(1, 10, '2026-03-01T17:00:00.000Z', 220),
  ], { tz: 'Europe/Zurich' });
  assert.deepEqual(chapters['1'].points, [{ d: '2026-03-01', c: 220, w: 37 }]);
});

test('buildChapterGrowth: Tagesgrenze folgt der App-Zeitzone, nicht UTC', () => {
  // 22:30 UTC = 00:30 Ortszeit des Folgetags in Europe/Zurich (CEST).
  const rows = [rev(1, 10, '2026-07-01T22:30:00.000Z', 100)];
  assert.equal(buildChapterGrowth(rows, { tz: 'Europe/Zurich' }).chapters['1'].points[0].d, '2026-07-02');
  assert.equal(buildChapterGrowth(rows, { tz: 'UTC' }).chapters['1'].points[0].d, '2026-07-01');
});

test('buildChapterGrowth: Kapitel bleiben getrennt', () => {
  const { chapters } = buildChapterGrowth([
    rev(1, 10, '2026-03-01T09:00:00.000Z', 100),
    rev(2, 20, '2026-03-01T09:00:00.000Z', 900),
  ], { tz: 'UTC' });
  assert.equal(chapters['1'].points[0].c, 100);
  assert.equal(chapters['2'].points[0].c, 900);
});

// ── Client: Scope-Merge ─────────────────────────────────────────────────────

test('mergeScopeSeries: summiert fortgeschrieben ueber mehrere Kapitel', () => {
  const chapters = {
    1: { points: [{ d: '2026-03-01', c: 100, w: 10 }, { d: '2026-03-10', c: 300, w: 30 }], pages: [10] },
    2: { points: [{ d: '2026-03-05', c: 200, w: 20 }], pages: [20] },
  };
  const { points, tracked } = mergeScopeSeries(chapters, new Set(['1', '2']));
  assert.deepEqual(points, [
    { iso: '2026-03-01', chars: 100, words: 10 },  // Kapitel 2 existiert noch nicht
    { iso: '2026-03-05', chars: 300, words: 30 },  // Kapitel 1 laeuft mit seinem Stand mit
    { iso: '2026-03-10', chars: 500, words: 50 },
  ]);
  assert.deepEqual([...tracked].sort(), [10, 20]);
});

test('mergeScopeSeries: Kapitel ausserhalb des Scopes zaehlen nicht', () => {
  const chapters = {
    1: { points: [{ d: '2026-03-01', c: 100, w: 10 }], pages: [10] },
    2: { points: [{ d: '2026-03-01', c: 999, w: 99 }], pages: [20] },
  };
  const { points } = mergeScopeSeries(chapters, new Set(['1']));
  assert.deepEqual(points, [{ iso: '2026-03-01', chars: 100, words: 10 }]);
});

// ── Client: Verdichtung auf die Kurvenachse ─────────────────────────────────

test('bucketSeries: Scheiben decken den Zeitraum lueckenlos bis heute ab', () => {
  const pts = [
    { iso: '2026-03-01', chars: 100, words: 10 },
    { iso: '2026-03-06', chars: 600, words: 60 },
  ];
  const out = bucketSeries(pts, '2026-03-10', 5);
  assert.equal(out.length, 5);
  assert.equal(out[0].iso, '2026-03-02');
  assert.equal(out[out.length - 1].iso, '2026-03-10');
  // Treppe: bis zur Scheibe mit dem 06. gilt der alte Stand weiter.
  assert.deepEqual(out.map(b => b.chars), [100, 100, 600, 600, 600]);
});

test('bucketSeries: kurzer Zeitraum bleibt tagesgenau (keine leeren Scheiben)', () => {
  const out = bucketSeries([{ iso: '2026-03-01', chars: 100, words: 10 }], '2026-03-03', 48);
  assert.deepEqual(out.map(b => b.iso), ['2026-03-01', '2026-03-02', '2026-03-03']);
});

test('isoAddDays/isoDiffDays ueberstehen den Sommerzeit-Wechsel', () => {
  // Europe/Zurich stellt in der Nacht auf den 29.03.2026 um.
  assert.equal(isoAddDays('2026-03-28', 2), '2026-03-30');
  assert.equal(isoDiffDays('2026-03-28', '2026-03-30'), 2);
});

// ── Client: Gesamtmodell ────────────────────────────────────────────────────

const CHAPTERS = {
  7: { points: [{ d: '2026-03-01', c: 1000, w: 160 }, { d: '2026-03-20', c: 4000, w: 640 }], pages: [10] },
};

test('computeGrowth: rechter Rand ist der Live-Stand, nicht die letzte Fassung', () => {
  const g = computeGrowth(CHAPTERS, new Set(['7']),
    [{ id: 10 }], { 10: { chars: 4200, words: 670 } }, { todayIso: '2026-04-01' });
  assert.equal(g.chars, 4200);
  assert.equal(g.points[g.points.length - 1].chars, 4200);
  assert.equal(g.net, 3200);              // 4200 heute − 1000 am ersten Stand
  assert.equal(g.firstIso, '2026-03-01');
  assert.equal(g.lastChangeIso, '2026-03-20');
  assert.equal(g.untrackedPages, 0);
});

test('computeGrowth: Seite ohne Fassungen ist ein konstanter Sockel, kein Loch', () => {
  const g = computeGrowth(CHAPTERS, new Set(['7']),
    [{ id: 10 }, { id: 11 }],
    { 10: { chars: 4000, words: 640 }, 11: { chars: 500, words: 80 } },
    { todayIso: '2026-04-01' });
  assert.equal(g.untrackedPages, 1);
  assert.equal(g.startChars, 1500);       // 1000 aus der Fassung + 500 Sockel
  assert.equal(g.chars, 4500);            // = Summe der Umfang-Kachel
  assert.equal(g.points[0].chars, 1500);
});

test('computeGrowth: ohne Historie kein Verlauf (die Kachel faellt weg)', () => {
  assert.equal(computeGrowth({}, new Set(['7']), [{ id: 10 }], { 10: { chars: 100 } }), null);
  // Alles am selben Tag: ein Punkt ist kein Verlauf.
  const heute = { 7: { points: [{ d: '2026-04-01', c: 100, w: 10 }], pages: [10] } };
  assert.equal(computeGrowth(heute, new Set(['7']), [{ id: 10 }],
    { 10: { chars: 100 } }, { todayIso: '2026-04-01' }), null);
});

test('computeGrowth: geschrumpftes Kapitel meldet negativen Zuwachs', () => {
  const g = computeGrowth(CHAPTERS, new Set(['7']),
    [{ id: 10 }], { 10: { chars: 700, words: 110 } }, { todayIso: '2026-04-01' });
  assert.equal(g.net, -300);
  assert.equal(g.netPct, -30);
});

test('computeGrowth: Geometrie bleibt im Viewbox und endet am letzten Punkt', () => {
  const g = computeGrowth(CHAPTERS, new Set(['7']),
    [{ id: 10 }], { 10: { chars: 4200 } }, { todayIso: '2026-04-01' });
  const { d, area, endX, endY, w, h } = g.geometry;
  assert.match(d, /^M/);
  assert.match(area, /Z$/);
  assert.ok(endX <= w && endY >= 0 && endY <= h);
  assert.equal(Math.round(endX), w - 4);  // letzter Punkt am rechten Rand (pad 4)
});

// ── Template-Drift ──────────────────────────────────────────────────────────

test('das Partial traegt denselben viewBox wie growthGeometry()', () => {
  // Der viewBox steht im Partial als Literal, weil der HTML-Parser Attributnamen
  // kleinschreibt: ein gebundenes `:viewBox` landet als wirkungsloses `viewbox`
  // im SVG, und die Kurve waere auf 300x150 (SVG-Default) gequetscht. Damit
  // existiert die Zahl zweimal — hier ist die Klammer dagegen.
  const html = readFileSync(
    fileURLToPath(new URL('../../public/partials/kapitelreview-dash-verlauf.html', import.meta.url)),
    'utf8');
  const { w, h } = growthGeometry([{ chars: 1 }, { chars: 2 }]);
  assert.match(html, new RegExp(`viewBox="0 0 ${w} ${h}"`));
  // Und die Flaeche braucht einen `x-id`-Scope, sonst zeigt ihr `url(#…)` auf
  // einen Verlauf, den es nicht gibt (jeder `$id`-Aufruf zaehlte sonst hoch).
  assert.match(html, /x-id="\['kd-grow'\]"/);
});

test('isoAddDays/isoDiffDays rechnen unabhaengig von Browser-TZ und appTimezone', async () => {
  // Browser in Pacific/Kiritimati (UTC+14), App in Pacific/Pago_Pago (UTC−11):
  // ein Browser-Mittag liegt in der App-Zone noch am Vortag. Die Kalender-
  // arithmetik darf davon nichts merken. Kindprozess, weil TZ beim Start greift.
  const { execFileSync } = await import('node:child_process');
  const mod = new URL('../../public/js/cards/kapitel-growth.js', import.meta.url).href;
  const utils = new URL('../../public/js/utils/date.js', import.meta.url).href;
  const script = `
    globalThis.window = globalThis.window || {};
    (await import(${JSON.stringify(utils)})).configureAppTimezone('Pacific/Pago_Pago');
    const m = await import(${JSON.stringify(mod)});
    console.log(JSON.stringify([m.isoAddDays('2026-03-28', 2), m.isoAddDays('2026-01-01', -1), m.isoDiffDays('2025-12-31', '2026-01-02')]));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, TZ: 'Pacific/Kiritimati' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), ['2026-03-30', '2025-12-31', 2]);
});
