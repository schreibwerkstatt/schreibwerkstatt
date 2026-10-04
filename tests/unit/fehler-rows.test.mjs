// Render-fertige Zeilen der Fehler-Heatmap: public/js/book/fehler-heatmap.js
// #buildFehlerRows / #buildFehlerTotals / #fehlerTrendDenominator.
//
// Festgehalten wird, WORAN sich die Farbe orientiert: an der Dichte (Befunde pro
// 1000 geprueften Woertern), nicht an der Anzahl. Nach der Anzahl gefaerbt waere
// jedes lange Kapitel in jeder Spalte rot.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFehlerRows, buildFehlerTotals, fehlerTrendDenominator,
} from '../../public/js/book/fehler-heatmap.js';
import { HEATMAP_MIN_WORDS } from '../../public/js/utils.js';

const TYPEN = ['stil', 'grammatik'];

const chapter = (id, over = {}) => ({
  chapter_id: id, chapter_name: `K${id}`,
  pages_total: 2, pages_checked: 2, words: 2000, words_checked: 2000, ...over,
});
const data = (chapters, matrix, totals = {}) => ({ mode: 'open', chapters, matrix, totals, details: {} });

test('Farbe folgt der Dichte, nicht der Anzahl', () => {
  // K1: langes Kapitel, 20 Befunde auf 20 000 Woertern = 1/1k.
  // K2: kurzes Kapitel,  5 Befunde auf  1 000 Woertern = 5/1k.
  const rows = buildFehlerRows(data(
    [chapter(1, { words: 20000, words_checked: 20000 }), chapter(2, { words: 1000, words_checked: 1000 })],
    { 1: { stil: { count: 20, per1k: 1, pages: 2 } }, 2: { stil: { count: 5, per1k: 5, pages: 1 } } },
  ), TYPEN, 'de');
  assert.equal(rows[0].cells.stil.vars['--heatmap-t'], '0%', 'mehr Befunde, aber duenner → gruen');
  assert.equal(rows[1].cells.stil.vars['--heatmap-t'], '100%', 'weniger Befunde, aber dichter → rot');
  assert.equal(rows[0].cells.stil.text, '20', 'die Zahl bleibt die Anzahl');
});

test('geprueft ohne Befund zaehlt als Dichte 0 und wird gruen, nicht neutral', () => {
  const rows = buildFehlerRows(data(
    [chapter(1), chapter(2), chapter(3)],
    { 1: { stil: { count: 4, per1k: 2, pages: 1 } }, 2: { stil: { count: 2, per1k: 1, pages: 1 } }, 3: {} },
  ), TYPEN, 'de');
  const zero = rows[2].cells.stil;
  assert.ok(zero.cls.startsWith('heatmap-cell--tinted'));
  assert.equal(zero.vars['--heatmap-t'], '0%');
  assert.equal(zero.text, '–');
  assert.equal(zero.clickable, false, 'ohne Befund kein Detail-Panel');
  assert.equal(rows[1].cells.stil.vars['--heatmap-t'], '50%', 'ein Befund ist nicht mehr das gruene Ende');
});

test('ungeprueftes Kapitel ist schraffiert und ohne Tooltip-Daten', () => {
  const [row] = buildFehlerRows(data([chapter(1, { pages_checked: 0, words_checked: 0 })], {}), TYPEN, 'de');
  assert.ok(row.cells.stil.cls.startsWith('heatmap-cell--empty'));
  assert.equal(row.cells.stil.tip, null);
});

test('unter der Mindestmenge: Zahl ja, Farbe nein, kein Einfluss auf die Skala', () => {
  const tiny = HEATMAP_MIN_WORDS - 1;
  const rows = buildFehlerRows(data(
    [chapter(1), chapter(2), chapter(3, { words: tiny, words_checked: tiny })],
    {
      1: { stil: { count: 2, per1k: 1, pages: 1 } },
      2: { stil: { count: 6, per1k: 3, pages: 1 } },
      3: { stil: { count: 5, per1k: 50, pages: 1 } }, // Ausreisser auf winziger Basis
    },
  ), TYPEN, 'de');
  assert.ok(rows[2].cells.stil.cls.startsWith('heatmap-cell--lowdata'));
  assert.deepEqual(rows[2].cells.stil.vars, {});
  assert.equal(rows[2].cells.stil.tip.lowData, true);
  // Ohne den Ausreisser spannt die Skala 1..3 — K2 ist rot, nicht blassgruen.
  assert.equal(rows[1].cells.stil.vars['--heatmap-t'], '100%');
});

test('kurzes Buch: erreichen weniger als zwei Kapitel die Schwelle, gilt sie nicht', () => {
  const rows = buildFehlerRows(data(
    [chapter(1, { words_checked: 100 }), chapter(2, { words_checked: 120 })],
    { 1: { stil: { count: 1, per1k: 10, pages: 1 } }, 2: { stil: { count: 3, per1k: 25, pages: 1 } } },
  ), TYPEN, 'de');
  assert.ok(rows[0].cells.stil.cls.startsWith('heatmap-cell--tinted'));
  assert.equal(rows[1].cells.stil.vars['--heatmap-t'], '100%');
});

test('Teilabdeckung blasst ab, die Zellklasse bleibt tinted', () => {
  const rows = buildFehlerRows(data(
    [chapter(1, { pages_checked: 1 }), chapter(2)],
    { 1: { stil: { count: 1, per1k: 1, pages: 1 } }, 2: { stil: { count: 4, per1k: 2, pages: 1 } } },
  ), TYPEN, 'de');
  assert.equal(rows[0].coveragePct, 50);
  assert.equal(rows[0].cells.stil.vars['--heatmap-opacity'], '0.75');
  assert.equal(rows[1].cells.stil.vars['--heatmap-opacity'], '1');
});

test('klickbare Zellen tragen internal-link und den Detail-Schluessel der Antwort', () => {
  const [row] = buildFehlerRows(data([chapter(null, { chapter_name: null })], { __uncat__: { stil: { count: 2, per1k: 1, pages: 1 } } }), TYPEN, 'de');
  assert.equal(row.key, '__uncat__');
  assert.equal(row.cells.stil.detailKey, '__uncat__:stil');
  assert.ok(row.cells.stil.cls.includes('internal-link'));
  assert.ok(!row.cells.grammatik.cls.includes('internal-link'));
});

test('Summenzeile: Dichte gegen alle geprueften Woerter des Buchs', () => {
  const t = buildFehlerTotals(data(
    [chapter(1, { words_checked: 1500 }), chapter(2, { words_checked: 500 })], {}, { stil: 6 },
  ), TYPEN, 'de');
  assert.equal(t.wordsChecked, 2000);
  assert.equal(t.cells.stil.count, 6);
  assert.match(t.cells.stil.per1k, /^3[.,]0$/, '6 Befunde auf 2000 Woertern');
  assert.equal(t.cells.grammatik.text, '–');
});

test('Trend-Nenner: gepruefte Woerter, aeltere Fassungen als Naeherung', () => {
  assert.deepEqual(fehlerTrendDenominator({ words: 9000, metrics: { words_checked: 3000 } }), { words: 3000, approx: false });
  assert.deepEqual(fehlerTrendDenominator({ words: 9000, metrics: { open: { total: 1 } } }), { words: 9000, approx: true });
  assert.deepEqual(fehlerTrendDenominator({ words: 9000, metrics: { words_checked: 0 } }), { words: 0, approx: false });
});
