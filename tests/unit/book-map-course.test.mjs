// Buchlandkarte — Erweiterungen der puren Mathematik (lib/book-map/): drei
// PCA-Komponenten, Pol-Achsen, Passagen-Punkte, Ähnlichkeitsmatrix mit
// Bruchstellen und Echos, plus die Options-Parser der zwei Jobs. Kein DB-/
// Netz-Zugriff. Wie book-map.test.mjs: geprüft werden Eigenschaften, nicht
// Koordinaten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bm = require('../../lib/book-map.js');
const { parseBookMapOptions } = require('../../routes/jobs/book-map.js');
const { parseLabelAxes } = require('../../routes/jobs/book-map-label.js');

const DIM = 24;

// Deterministisches Rauschen (LCG), damit „gleichförmig" auch gleichförmig ist:
// ein Sinus-Muster über den Index hätte selbst Struktur in Lesereihenfolge.
function noiseAt(i, k) {
  let s = (Math.imul(i + 1, 2654435761) ^ Math.imul(k + 7, 40503)) >>> 0;
  s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
  return s / 4294967296 - 0.5;
}

// Einheitsvektor um eine Basisrichtung, mit kleinem deterministischem Rauschen.
function around(axis, i, noise = 0.08) {
  const v = new Float32Array(DIM);
  v[axis] = 1;
  for (let k = 0; k < DIM; k++) v[k] += noise * noiseAt(i, k);
  return bm.unitVector(v);
}

async function analyse(points) {
  const mx = await bm.similarityMatrix(points);
  const w = bm.kernelWidth(mx.size);
  const curve = bm.novelty(mx.data, mx.size, w);
  const bounds = bm.boundaries(mx.data, mx.size, curve, { w });
  return { mx, w, bounds, echoes: bm.echoes(mx.data, mx.size, bm.segmentsFrom(bounds, mx.size), { w }) };
}
const pt = (id, vector, chapterId = null) => ({ id, chapterId, vector });

// ── PCA mit drei Komponenten ────────────────────────────────────────────────

test('projectAsync: drei Komponenten, Anteile exakt und zusammen höchstens 1', async () => {
  const points = [];
  for (let i = 0; i < 30; i++) points.push(pt(i, around(i % 3, i, 0.3)));
  const { values, variances } = await bm.projectAsync(points, { components: 3 });
  assert.equal(values.length, 3);
  assert.equal(values[0].length, 30);
  const sum = variances.reduce((a, b) => a + b, 0);
  assert.ok(sum <= 1 + 1e-9, `Summe ${sum}`);
  assert.ok(variances[0] >= variances[1] - 1e-9 && variances[1] >= variances[2] - 1e-9, 'absteigend');
  // Die drei Komponenten sind orthogonal → ihre Wertereihen unkorreliert.
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  assert.ok(Math.abs(dot(values[0], values[1])) < 1e-3 * 30);
  assert.ok(Math.abs(dot(values[1], values[2])) < 1e-3 * 30);
});

test('projectAsync: erste zwei Komponenten = project2d (gleicher Kern)', async () => {
  const points = [];
  for (let i = 0; i < 20; i++) points.push(pt(i, around(i % 2, i, 0.2)));
  const three = await bm.projectAsync(points, { components: 3 });
  const two = bm.project2d(points);
  assert.ok(Math.abs(two.explainedVariance - (three.variances[0] + three.variances[1])) < 1e-9);
});

test('scaleCommon: ein Faktor für alle Achsen', () => {
  const [a, b] = bm.scaleCommon([[2, -4], [1, 0.5]]);
  assert.deepEqual(a, [0.5, -1]);
  assert.deepEqual(b, [0.25, 0.125]);
});

// ── Pol-Achsen ──────────────────────────────────────────────────────────────

test('poleProjection: positiv heisst näher an Pol A', () => {
  const points = [];
  for (let i = 0; i < 10; i++) points.push(pt(i, around(0, i)));   // bei A
  for (let i = 10; i < 20; i++) points.push(pt(i, around(1, i)));  // bei B
  const A = around(0, 99, 0);
  const B = around(1, 98, 0);
  const { values, variances } = bm.poleProjection(points, [[A, B]]);
  const meanA = values[0].slice(0, 10).reduce((s, v) => s + v, 0) / 10;
  const meanB = values[0].slice(10).reduce((s, v) => s + v, 0) / 10;
  assert.ok(meanA > 0 && meanB < 0, `${meanA} / ${meanB}`);
  // Die Achse trennt genau die zwei Gruppen → sie trägt den Grossteil der Streuung.
  assert.ok(variances[0] > 0.5, `Anteil ${variances[0]}`);
});

test('poleProjection: identische Pole → null (keine Richtung)', () => {
  const points = [0, 1, 2, 3].map(i => pt(i, around(i % 2, i)));
  const A = around(0, 5, 0);
  assert.equal(bm.poleProjection(points, [[A, A]]), null);
});

// ── Passagen-Punkte ─────────────────────────────────────────────────────────

test('prepareChunkPoints: ein Punkt je Passage, kurze fallen weg, Reihenfolge Abschnitt/Passage', () => {
  const LONG = 'Ein ausreichend langer Beispieltext fuer den Chunk der Seite. ';
  const c = (entity_id, chunk_ix, v, text = LONG) => ({ entity_id, chunk_ix, chapter_id: 7, text, vector: Float32Array.from(v) });
  const pts = bm.prepareChunkPoints([
    c(2, 1, [0, 2, 0]), c(2, 0, [3, 0, 0]), c(1, 0, [0, 0, 1]), c(1, 1, [1, 0, 0], 'kurz'),
  ]);
  assert.deepEqual(pts.map(p => [p.id, p.ix]), [[1, 0], [2, 0], [2, 1]]);
  for (const p of pts) assert.ok(Math.abs(Math.hypot(...p.vector) - 1) < 1e-6);
});

// ── Matrix, Bruchstellen, Echos ─────────────────────────────────────────────

// Buch aus drei Teilen: 0–9 Thema 0, 10–19 Thema 1, 20–29 wieder Thema 0.
function threePartBook() {
  const points = [];
  for (let i = 0; i < 30; i++) {
    const topic = i < 10 ? 0 : i < 20 ? 1 : 0;
    points.push(pt(i, around(topic, i, 0.6)));
  }
  return points;
}

test('similarityMatrix: symmetrisch, Diagonale 1, zentriert (Werte unter null möglich)', async () => {
  const mx = await bm.similarityMatrix(threePartBook());
  const { size: m, data } = mx;
  assert.equal(m, 30);
  let neg = false;
  for (let i = 0; i < m; i++) {
    assert.equal(data[i * m + i], 1);
    for (let j = 0; j < m; j++) {
      assert.equal(data[i * m + j], data[j * m + i]);
      if (data[i * m + j] < 0) neg = true;
    }
  }
  assert.ok(neg, 'zentriert: unähnliche Teile liegen unter null');
});

test('similarityMatrix: über dem Deckel werden aufeinanderfolgende Abschnitte zu Fächern', async () => {
  const mx = await bm.similarityMatrix(threePartBook(), { maxSize: 10 });
  assert.equal(mx.size, 10);
  assert.deepEqual(mx.bins[0], [0, 1, 2]);
  assert.equal(mx.bins.flat().length, 30);
});

test('novelty + boundaries: die zwei Themenwechsel werden gefunden', async () => {
  const { bounds } = await analyse(threePartBook());
  assert.deepEqual(bounds.map(b => b.ix).sort((a, b) => a - b), [10, 20]);
});

test('boundaries: ein gleichförmiges Buch hat keine Bruchstellen (Permutationstest)', async () => {
  for (const n of [30, 80]) {
    const points = [];
    for (let i = 0; i < n; i++) points.push(pt(i, around(0, i, 0.8)));
    const { bounds } = await analyse(points);
    assert.deepEqual(bounds, [], `n=${n}`);
  }
});

test('boundaries: abwechselnde Themen ohne Blöcke ergeben keine Bruchstellen', async () => {
  const points = [];
  for (let i = 0; i < 60; i++) points.push(pt(i, around(i % 3, i, 0.6)));
  const { bounds } = await analyse(points);
  assert.deepEqual(bounds, []);
});

test('boundaries: deterministisch, und nur in einem Buch mit Ordnung', async () => {
  const mx = await bm.similarityMatrix(threePartBook());
  const w = bm.kernelWidth(mx.size);
  const curve = bm.novelty(mx.data, mx.size, w);
  assert.deepEqual(bm.boundaries(mx.data, mx.size, curve, { w }), bm.boundaries(mx.data, mx.size, curve, { w }));
  assert.equal(bm.hasSequentialStructure(mx.data, mx.size, w), true);
});

test('echoes: der vierte Teil kehrt zum ersten zurück — nur dieses Paar ist ein Echo', async () => {
  const points = [];
  for (let i = 0; i < 40; i++) {
    const topic = i < 10 ? 0 : i < 20 ? 1 : i < 30 ? 2 : 0;
    points.push(pt(i, around(topic, i, 0.6)));
  }
  const { bounds, echoes } = await analyse(points);
  assert.deepEqual(bounds.map(b => b.ix).sort((a, b) => a - b), [10, 20, 30]);
  assert.ok(echoes.length > 0);
  for (const e of echoes) {
    assert.ok(e.a < 10 && e.b >= 30, `Echo ${e.a}–${e.b} gehört nicht zum Rückgriff`);
  }
});

test('echoes: ohne Rückkehr kein Echo', async () => {
  const points = [];
  for (let i = 0; i < 40; i++) points.push(pt(i, around(Math.floor(i / 10), i, 0.6)));
  const { echoes } = await analyse(points);
  assert.deepEqual(echoes, []);
});

test('encodeUpperTriangle: Rundreise auf einen Prozentpunkt genau', async () => {
  const mx = await bm.similarityMatrix(threePartBook());
  const bytes = bm.encodeUpperTriangle(mx.data, mx.size);
  assert.equal(bytes.length, (mx.size * (mx.size + 1)) / 2);
  let k = 0;
  for (let i = 0; i < mx.size; i++) {
    for (let j = i; j < mx.size; j++) {
      const back = bytes[k++] / 127.5 - 1;
      assert.ok(Math.abs(back - mx.data[i * mx.size + j]) <= 1 / 127.5 + 1e-6);
    }
  }
});

// ── Options-Parser ──────────────────────────────────────────────────────────

test('parseBookMapOptions: Defaults, Granularität, Pole', () => {
  assert.deepEqual(parseBookMapOptions({}), { granularity: 'page', poles: null });
  assert.deepEqual(parseBookMapOptions({ granularity: 'chunk' }), { granularity: 'chunk', poles: null });
  assert.equal(parseBookMapOptions({ granularity: 'satz' }).error, 'granularity');
  const ok = parseBookMapOptions({
    poles: { x: [{ kind: 'figure', id: '3' }, { kind: 'text', text: '  Geschäft ' }], y: null },
  });
  assert.deepEqual(ok.poles, { x: [{ kind: 'figure', id: 3 }, { kind: 'text', text: 'Geschäft' }], y: null });
  // Halbe Achse, leerer Begriff, unbekannte Art, zu langer Begriff → Fehler.
  assert.equal(parseBookMapOptions({ poles: { x: [{ kind: 'figure', id: 3 }] } }).error, 'poles');
  assert.equal(parseBookMapOptions({ poles: { x: [{ kind: 'text', text: ' ' }, { kind: 'figure', id: 1 }] } }).error, 'poles');
  assert.equal(parseBookMapOptions({ poles: { x: [{ kind: 'page', id: 1 }, { kind: 'figure', id: 1 }] } }).error, 'poles');
  assert.equal(parseBookMapOptions({ poles: { x: [{ kind: 'text', text: 'x'.repeat(201) }, { kind: 'figure', id: 1 }] } }).error, 'poles');
});

test('parseLabelAxes: höchstens drei Achsen, je Ende 1–4 eindeutige IDs', () => {
  assert.deepEqual(parseLabelAxes({ axes: [{ neg: [1, '2', 2], pos: [3] }] }), [{ neg: [1, 2], pos: [3] }]);
  assert.deepEqual(parseLabelAxes({ axes: [{ neg: [1, 2, 3, 4, 5], pos: [6] }] })[0].neg, [1, 2, 3, 4]);
  assert.equal(parseLabelAxes({ axes: [] }), null);
  assert.equal(parseLabelAxes({ axes: [{ neg: [], pos: [1] }] }), null);
  assert.equal(parseLabelAxes({ axes: [1, 2, 3, 4].map(() => ({ neg: [1], pos: [2] })) }), null);
});
