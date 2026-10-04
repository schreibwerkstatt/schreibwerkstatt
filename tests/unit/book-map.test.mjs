// Buchlandkarte — pure Mathematik (lib/book-map.js): Punkt-Verdichtung,
// PCA-Projektion, Kapitel-Kennzahlen, Ausreisser. Kein DB-/Netz-Zugriff.
//
// Die Tests pruefen die Eigenschaften, auf die sich die Karte verlaesst — nicht
// konkrete Koordinaten: eine Eigenrichtung ist nur bis aufs Vorzeichen bestimmt,
// ein Test auf feste x/y waere darum ein Test auf die Laune der Iteration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  preparePoints, project2d, project2dAsync, chapterStats, splitChapter, outliers,
} = require('../../lib/book-map.js');

const LONG = 'Ein ausreichend langer Beispieltext fuer den Chunk der Seite. ';

function chunk(entity_id, chapter_id, vector, { text = LONG, chunk_ix = 0 } = {}) {
  return { entity_id, chapter_id, chunk_ix, text, vector: Float32Array.from(vector) };
}

// ── preparePoints ───────────────────────────────────────────────────────────

test('preparePoints: ein Punkt je Seite, Vektoren auf Einheitslaenge', () => {
  const { points } = preparePoints([
    chunk(1, 10, [3, 0, 0]),
    chunk(1, 10, [0, 3, 0], { chunk_ix: 1 }),
    chunk(2, 10, [0, 0, 5]),
  ]);
  assert.equal(points.length, 2);
  const p1 = points.find(p => p.id === 1);
  assert.equal(p1.chunks, 2);
  // Mittel aus (3,0,0) und (0,3,0), normiert → beide Komponenten gleich gross.
  const norm = Math.hypot(...p1.vector);
  assert.ok(Math.abs(norm - 1) < 1e-6, `Norm ${norm} sollte 1 sein`);
  assert.ok(Math.abs(p1.vector[0] - p1.vector[1]) < 1e-6);
});

test('preparePoints: zu kurze Chunks und Nullvektoren fallen heraus', () => {
  const { points } = preparePoints([
    chunk(1, null, [1, 0, 0], { text: 'kurz' }),
    chunk(2, null, [0, 0, 0]),
    chunk(3, null, [0, 1, 0]),
  ]);
  assert.deepEqual(points.map(p => p.id), [3]);
});

test('preparePoints: Reihenfolge ist stabil (nach id), unabhaengig von der Eingabe', () => {
  const mk = (order) => preparePoints(order.map(id => chunk(id, null, [id, 1, 0]))).points.map(p => p.id);
  assert.deepEqual(mk([3, 1, 2]), [1, 2, 3]);
  assert.deepEqual(mk([2, 3, 1]), [1, 2, 3]);
});

test('preparePoints: Chunk mit fremder Dimension kippt die Seite nicht', () => {
  const { points } = preparePoints([
    chunk(1, null, [1, 0, 0]),
    chunk(1, null, [1, 0, 0, 0], { chunk_ix: 1 }), // Fremdmodell-Rest
  ]);
  assert.equal(points.length, 1);
  assert.equal(points[0].chunks, 1);
});

// ── project2d ───────────────────────────────────────────────────────────────

test('project2d: Koordinate je Punkt, in der Einheitsbox', () => {
  const { points } = preparePoints([
    chunk(1, null, [1, 0, 0]),
    chunk(2, null, [0, 1, 0]),
    chunk(3, null, [0, 0, 1]),
    chunk(4, null, [1, 1, 0]),
  ]);
  const { coords, explainedVariance } = project2d(points);
  assert.equal(coords.length, points.length);
  for (const [x, y] of coords) {
    assert.ok(Math.abs(x) <= 1 + 1e-6 && Math.abs(y) <= 1 + 1e-6, `(${x},${y}) ausserhalb der Box`);
  }
  assert.ok(explainedVariance > 0 && explainedVariance <= 1);
});

test('project2d: deterministisch — gleiche Eingabe, gleiches Ergebnis', () => {
  const build = () => preparePoints([
    chunk(1, null, [1, 0.2, 0]),
    chunk(2, null, [0.9, 0.1, 0.1]),
    chunk(3, null, [0, 1, 0.3]),
    chunk(4, null, [0.1, 0.9, 0]),
    chunk(5, null, [0, 0.2, 1]),
  ]).points;
  assert.deepEqual(project2d(build()).coords, project2d(build()).coords);
});

test('project2d: zwei getrennte Gruppen liegen in der Projektion getrennt', () => {
  // Zwei Cluster mit je drei Punkten, orthogonal zueinander.
  const { points } = preparePoints([
    chunk(1, null, [1, 0, 0, 0]), chunk(2, null, [0.98, 0.02, 0, 0]), chunk(3, null, [0.97, 0, 0.03, 0]),
    chunk(4, null, [0, 0, 0, 1]), chunk(5, null, [0, 0.02, 0, 0.98]), chunk(6, null, [0, 0, 0.03, 0.97]),
  ]);
  const { coords } = project2d(points);
  const at = (id) => coords[points.findIndex(p => p.id === id)];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const inner = Math.max(dist(at(1), at(2)), dist(at(4), at(5)));
  const across = dist(at(1), at(4));
  assert.ok(across > inner * 3, `Cluster-Abstand ${across} sollte den Innenabstand ${inner} klar uebertreffen`);
});

test('project2d: beide Achsen teilen einen Faktor — eine langgezogene Wolke bleibt langgezogen', () => {
  // Weit gestreut in der einen Richtung, schmal in der anderen. Wuerden die
  // Achsen GETRENNT auf [-1,1] skaliert, saehe die Wolke rund aus — und die
  // einzige Aussage der Karte („diese zwei liegen nah") waere verzerrt.
  const chunks = [];
  for (let i = -5; i <= 5; i++) {
    chunks.push(chunk(i + 6, null, [1, i * 0.2, ((i % 3) - 1) * 0.01, 0]));
  }
  const { points } = preparePoints(chunks);
  const { coords } = project2d(points);
  const extent = (ix) => Math.max(...coords.map(c => Math.abs(c[ix])));
  // Bei GETRENNTER Skalierung waeren beide Ausdehnungen exakt 1 — der Abstand
  // zur Haelfte ist die Reserve gegen Rundungsrauschen in beide Richtungen.
  assert.ok(extent(1) < extent(0) / 2,
    `y-Ausdehnung ${extent(1)} muesste klar unter der x-Ausdehnung ${extent(0)} liegen`);
});

test('project2d: unter drei Punkten keine Projektion, aber auch kein Absturz', () => {
  const { points } = preparePoints([chunk(1, null, [1, 0, 0]), chunk(2, null, [0, 1, 0])]);
  const { coords, explainedVariance } = project2d(points);
  assert.deepEqual(coords, [[0, 0], [0, 0]]);
  assert.equal(explainedVariance, 0);
});

test('project2d: identische Punkte haben keine Streuung → Nullkoordinaten', () => {
  const { points } = preparePoints([
    chunk(1, null, [1, 0, 0]), chunk(2, null, [1, 0, 0]), chunk(3, null, [1, 0, 0]),
  ]);
  const { coords } = project2d(points);
  for (const [x, y] of coords) {
    assert.ok(Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6);
  }
});

// ── chapterStats ────────────────────────────────────────────────────────────

test('chapterStats: geschlossenes Kapitel rankt hoeher als zerfallendes', () => {
  const { points } = preparePoints([
    // Kapitel 1: alle drei Seiten nah beieinander.
    chunk(1, 1, [1, 0, 0, 0]), chunk(2, 1, [0.98, 0.02, 0, 0]), chunk(3, 1, [0.99, 0, 0.01, 0]),
    // Kapitel 2: zwei Haelften, die nichts miteinander zu tun haben.
    chunk(4, 2, [1, 0, 0, 0]), chunk(5, 2, [0, 0, 0, 1]),
  ]);
  const stats = chapterStats(points);
  const c1 = stats.find(c => c.chapterId === 1);
  const c2 = stats.find(c => c.chapterId === 2);
  assert.ok(c1.cohesion > c2.cohesion, `${c1.cohesion} sollte > ${c2.cohesion} sein`);
  assert.ok(c2.spread > c1.spread, 'das zerfallende Kapitel hat die groessere Streuung');
  assert.equal(c1.pages, 3);
});

test('chapterStats: Ein-Seiten-Kapitel behauptet keine Geschlossenheit', () => {
  const { points } = preparePoints([
    chunk(1, 1, [1, 0, 0]),
    chunk(2, 2, [0, 1, 0]), chunk(3, 2, [0, 0.99, 0.01]),
  ]);
  const c1 = chapterStats(points).find(c => c.chapterId === 1);
  assert.equal(c1.cohesion, null, 'ohne zweite Seite gibt es keinen Wert, auch nicht 1.0');
  assert.equal(c1.spread, null);
});

test('chapterStats: nearest zeigt auf das inhaltlich naechste Kapitel', () => {
  const { points } = preparePoints([
    chunk(1, 1, [1, 0, 0, 0]), chunk(2, 1, [0.99, 0.01, 0, 0]),
    chunk(3, 2, [0.9, 0.1, 0, 0]), chunk(4, 2, [0.95, 0.05, 0, 0]),  // nah an Kapitel 1
    chunk(5, 3, [0, 0, 0, 1]), chunk(6, 3, [0, 0, 0.01, 0.99]),      // weit weg
  ]);
  const stats = chapterStats(points);
  assert.equal(stats.find(c => c.chapterId === 1).nearestChapterId, 2);
  assert.equal(stats.find(c => c.chapterId === 2).nearestChapterId, 1);
});

test('chapterStats: kapitellose Seiten erzeugen keine Kapitel-Zeile', () => {
  const { points } = preparePoints([chunk(1, null, [1, 0, 0]), chunk(2, null, [0, 1, 0])]);
  assert.deepEqual(chapterStats(points), []);
});

test('chapterStats: einzelnes Kapitel hat keinen Nachbarn', () => {
  const { points } = preparePoints([chunk(1, 1, [1, 0, 0]), chunk(2, 1, [0.9, 0.1, 0])]);
  const c = chapterStats(points)[0];
  assert.equal(c.nearestChapterId, null);
  assert.equal(c.nearestScore, null);
});

// ── outliers ────────────────────────────────────────────────────────────────

test('outliers: die abseits liegende Seite steht oben — und nur sie', () => {
  const { points } = preparePoints([
    chunk(1, 1, [1, 0, 0, 0]), chunk(2, 1, [0.99, 0.01, 0, 0]),
    chunk(3, 1, [0.98, 0.02, 0, 0]), chunk(4, 1, [0.97, 0, 0.03, 0]),
    chunk(5, 1, [0.985, 0.01, 0.01, 0]), chunk(6, 1, [0.975, 0.02, 0, 0.01]),
    chunk(9, 1, [0, 0, 0, 1]), // der Exkurs
  ]);
  const rows = outliers(points);
  assert.deepEqual(rows.map(r => r.id), [9]);
});

test('outliers: gleichfoermiges Buch hat keine Ausreisser', () => {
  // Eine feste Top-K-Liste haette hier die zehn „entlegensten" Seiten
  // angeprangert, obwohl keine aus der Reihe faellt.
  const chunks = [];
  for (let i = 1; i <= 20; i++) chunks.push(chunk(i, 1, [1, Math.sin(i) * 0.05, Math.cos(i) * 0.05]));
  const { points } = preparePoints(chunks);
  assert.deepEqual(outliers(points), []);
});

test('outliers: absteigend nach Abstand, topK deckelt die Liste', () => {
  const chunks = [];
  for (let i = 1; i <= 20; i++) chunks.push(chunk(i, 1, [1, Math.sin(i) * 0.02, 0, 0]));
  for (let i = 0; i < 8; i++) chunks.push(chunk(100 + i, 2, [0.2 + i * 0.05, 0, 1, 0]));
  const { points } = preparePoints(chunks);
  const rows = outliers(points, { topK: 5 });
  assert.equal(rows.length, 5);
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].distance >= rows[i].distance);
  assert.ok(rows.every(r => r.id >= 100));
});

test('outliers: unter drei Seiten keine Aussage', () => {
  const { points } = preparePoints([chunk(1, 1, [1, 0, 0]), chunk(2, 1, [0, 1, 0])]);
  assert.deepEqual(outliers(points), []);
});

// ── Kohaesion ohne Groessen-Bias ────────────────────────────────────────────

// Deterministisches Rauschen (kein Math.random — der Test soll reproduzierbar sein).
function noiseGen(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
}

test('chapterStats: Kohaesion haengt nicht an der Kapitelgroesse', () => {
  // Zwei Kapitel, Seiten aus DERSELBEN Verteilung — eins mit 2, eins mit 20
  // Seiten. Gegen den eigenen Schwerpunkt gemessen saehe das kleine Kapitel
  // geschlossener aus, Leave-one-out kippte es ins Gegenteil.
  const rnd = noiseGen(3);
  const dim = 128;
  const common = Array.from({ length: dim }, rnd);
  const chunks = [];
  let id = 1;
  for (const [ch, n] of [[1, 2], [2, 20]]) {
    for (let k = 0; k < n; k++) chunks.push(chunk(id++, ch, common.map(c => c * 3 + rnd())));
  }
  const stats = chapterStats(preparePoints(chunks).points);
  const small = stats.find(c => c.chapterId === 1).cohesion;
  const big = stats.find(c => c.chapterId === 2).cohesion;
  assert.ok(Math.abs(small - big) < 0.02, `klein ${small} vs. gross ${big} — sollten gleich liegen`);
});

test('chapterStats: nearestScore ist gegen den Buch-Schwerpunkt zentriert', () => {
  // Alle Seiten teilen eine starke gemeinsame Richtung, die Kapitel sind
  // sonst Rauschen. Roh laegen die Kapitel-Schwerpunkte bei ~97 % Naehe.
  const rnd = noiseGen(11);
  const dim = 128;
  const common = Array.from({ length: dim }, rnd);
  const chunks = [];
  let id = 1;
  for (const ch of [1, 2, 3]) {
    for (let k = 0; k < 10; k++) chunks.push(chunk(id++, ch, common.map(c => c * 3 + rnd())));
  }
  for (const c of chapterStats(preparePoints(chunks).points)) {
    assert.ok(c.nearestScore < 0.6, `Kapitel ${c.chapterId}: ${c.nearestScore} — Gemeinsamkeit des Buchs zaehlt nicht als Naehe`);
  }
});

// ── Teilungs-Test ───────────────────────────────────────────────────────────

test('splitChapter: zwei Themen in einem Kapitel werden getrennt', () => {
  const rnd = noiseGen(5);
  const dim = 64;
  const common = Array.from({ length: dim }, rnd);
  const tA = Array.from({ length: dim }, rnd);
  const tB = Array.from({ length: dim }, rnd);
  const chunks = [];
  for (let k = 0; k < 12; k++) {
    const t = k < 6 ? tA : tB;
    chunks.push(chunk(k + 1, 1, common.map((c, i) => c * 3 + t[i] * 1.5 + rnd())));
  }
  const split = splitChapter(preparePoints(chunks).points);
  assert.ok(split, 'Teilung erwartet');
  assert.deepEqual(split.groups, [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]]);
  assert.ok(split.silhouette >= 0.25);
});

test('splitChapter: reines Rauschen ergibt keine Teilung', () => {
  const rnd = noiseGen(9);
  const dim = 64;
  const common = Array.from({ length: dim }, rnd);
  const chunks = [];
  for (let k = 0; k < 30; k++) chunks.push(chunk(k + 1, 1, common.map(c => c * 3 + rnd())));
  assert.equal(splitChapter(preparePoints(chunks).points), null);
});

test('splitChapter: zu kleines Kapitel wird nicht beurteilt', () => {
  const { points } = preparePoints([
    chunk(1, 1, [1, 0, 0]), chunk(2, 1, [1, 0.01, 0]), chunk(3, 1, [0, 0, 1]), chunk(4, 1, [0, 0.01, 1]),
  ]);
  assert.equal(splitChapter(points), null);
});

// ── Projektion: Varianz, Ausrichtung, Async ─────────────────────────────────

test('project2d: explainedVariance ist exakt — Punkte in einer Ebene → 100 %', () => {
  // Alle Vektoren in span{e1, e2}: die Normierung laesst sie dort, die Wolke
  // ist exakt zweidimensional.
  const { points } = preparePoints([
    chunk(1, null, [1, 0, 0, 0]), chunk(2, null, [0.6, 0.8, 0, 0]),
    chunk(3, null, [0, 1, 0, 0]), chunk(4, null, [-0.6, 0.8, 0, 0]),
  ]);
  const { explainedVariance } = project2d(points);
  assert.ok(explainedVariance > 0.999, `${explainedVariance}`);
});

test('project2d: orient legt die Achse fest — fruehe Seiten links', () => {
  // Gleiche Wolke, Reihenfolge der Buch-Positionen umgekehrt → x spiegelt.
  const { points } = preparePoints([
    chunk(1, null, [1, 0, 0, 0]), chunk(2, null, [0.8, 0.2, 0, 0]),
    chunk(3, null, [0.5, 0.5, 0, 0]), chunk(4, null, [0.2, 0.8, 0.05, 0]),
  ]);
  const fwd = project2d(points, { orient: [0, 1, 2, 3] }).coords;
  const rev = project2d(points, { orient: [3, 2, 1, 0] }).coords;
  assert.ok(fwd[0][0] < fwd[3][0], 'erste Seite links der letzten');
  assert.ok(rev[0][0] > rev[3][0], 'umgekehrte Ordnung spiegelt');
});

test('project2dAsync: gleiches Ergebnis wie synchron, ruft onStep', async () => {
  const { points } = preparePoints([
    chunk(1, null, [1, 0.2, 0]), chunk(2, null, [0.9, 0.1, 0.1]),
    chunk(3, null, [0, 1, 0.3]), chunk(4, null, [0.1, 0.9, 0]), chunk(5, null, [0, 0.2, 1]),
  ]);
  let steps = 0;
  const a = await project2dAsync(points, { onStep: () => { steps++; } });
  assert.deepEqual(a, project2d(points));
  assert.ok(steps > 0);
});

test('project2dAsync: ein Wurf in onStep bricht ab', async () => {
  const { points } = preparePoints([
    chunk(1, null, [1, 0.2, 0]), chunk(2, null, [0.9, 0.1, 0.1]),
    chunk(3, null, [0, 1, 0.3]), chunk(4, null, [0.1, 0.9, 0]),
  ]);
  await assert.rejects(project2dAsync(points, { onStep: () => { throw new Error('abort'); } }), /abort/);
});
