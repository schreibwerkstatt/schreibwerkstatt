// Share-Reader-Statistik, pure Kerne:
//   - Lesetiefe am Artikel (read-depth.js#spanDepthPct/chapterDepths)
//   - Verweildauer mit Leerlauf-Grenze (dwell.js#activeMs)
// Beide Module laufen ihr Widget nur mit `document`; in Node bleiben die
// Exporte übrig.

import test from 'node:test';
import assert from 'node:assert/strict';

const { spanDepthPct, chapterDepths } = await import('../../public/js/share-reader/read-depth.js');
const { activeMs, IDLE_MS } = await import('../../public/js/share-reader/dwell.js');

test('spanDepthPct: Anteil des Bereichs, geklemmt auf 0..100', () => {
  assert.equal(spanDepthPct(100, 200, 1200), 0, 'noch vor dem Artikel');
  assert.equal(spanDepthPct(700, 200, 1200), 50);
  assert.equal(spanDepthPct(1200, 200, 1200), 100, 'Artikelende = 100 %, egal was darunter steht');
  assert.equal(spanDepthPct(5000, 200, 1200), 100);
  assert.equal(spanDepthPct(10, 10, 10), 0, 'leerer Bereich teilt nicht durch 0');
});

test('chapterDepths: letztes Kapitel endet am Artikelende, nicht am Dokument', () => {
  const tops = [{ id: 1, top: 0 }, { id: 2, top: 1000 }, { id: 3, top: 2000 }];
  // Leser ist bis zum Artikelende (3000) gekommen; der Footer darunter zählt nicht.
  assert.deepEqual(chapterDepths(3000, tops, 3000), [
    { chapterId: 1, pct: 100 }, { chapterId: 2, pct: 100 }, { chapterId: 3, pct: 100 },
  ]);
  assert.deepEqual(chapterDepths(1500, tops, 3000), [
    { chapterId: 1, pct: 100 }, { chapterId: 2, pct: 50 }, { chapterId: 3, pct: 0 },
  ]);
});

test('activeMs: zählt nur bis IDLE_MS nach der letzten Eingabe', () => {
  const t0 = 1_000_000;
  assert.equal(activeMs(t0, t0 + 30_000, t0), 30_000, 'aktiv innerhalb der Grenze');
  assert.equal(activeMs(t0, t0 + 60 * 60_000, t0), IDLE_MS, 'offen vergessener Tab: nur bis zur Grenze');
  assert.equal(activeMs(t0 + IDLE_MS + 5000, t0 + IDLE_MS + 9000, t0), 0, 'Intervall ganz im Leerlauf');
  assert.equal(activeMs(t0, t0 - 1, t0), 0, 'rückwärts → 0');
});

test('activeMs: Zuhören (Vorlesen) zählt ohne Eingabe voll', () => {
  const t0 = 1_000_000;
  assert.equal(activeMs(t0, t0 + 20 * 60_000, t0, { listening: true }), 20 * 60_000);
});
