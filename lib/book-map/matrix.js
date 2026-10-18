'use strict';
// Ähnlichkeitsmatrix der Buchlandkarte (Tab „Verlauf"): jeder Abschnitt gegen
// jeden, beide Achsen in Lesereihenfolge. Re-exportiert von lib/book-map.js.
//
// WARUM NEBEN DER KARTE: eine 2D-Projektion zeigt bei einem Roman oft nur einen
// Bruchteil der Streuung, weil ein Roman keine zwei Hauptthemen hat. Die Matrix
// projiziert nicht — sie zeigt jede Paar-Ähnlichkeit, die es im Vollraum gibt.
// Und sie liest das Buch entlang der Zeit, wo die Karte nach Themen-Inseln
// fragt: helle Blöcke an der Diagonale sind zusammenhängende Teile, ein heller
// Fleck abseits ist eine Wiederaufnahme (Rückblende, wiederkehrendes Motiv).
//
// Aus der Matrix fallen zwei Befunde, die beide im Vollraum gerechnet sind:
//   - BRUCHSTELLEN: die Novelty-Kurve nach Foote (2000) — ein Schachbrett-Kern
//     gleitet über die Diagonale und misst, wie stark sich die Abschnitte davor
//     von denen danach unterscheiden. Ihre Spitzen sind die Stellen, an denen
//     das Buch inhaltlich umschlägt, unabhängig davon, wo Kapitelgrenzen liegen.
//     Eine Spitze zählt erst nach zwei Permutationstests (Buch hat eine
//     Ordnung; der Schnitt teilt sein Fenster besser als zufällige
//     Aufteilungen): jede Kurve hat Spitzen, auch die eines Buchs ohne Struktur.
//   - ECHOS: Paare, die zwischen sich einen ANDEREN Teil haben (mindestens zwei
//     Bruchstellen auseinander) und sich trotzdem so ähnlich sind wie
//     benachbarte Abschnitte — die Rückkehr zu etwas Früherem.

const { unit, dot, sumVectors, median } = require('./vec');

// Obergrenze der Matrix-Kantenlänge. Darüber werden aufeinanderfolgende
// Abschnitte zu Fächern zusammengefasst (Mittel ihrer Vektoren): 1000² Zellen
// sind die Grenze dessen, was ein Canvas noch als Einzelpixel zeigt, und die
// Rechnung (n²·dim) bliebe darunter im Sekundenbereich.
const MATRIX_MAX = 1000;
// Unterhalb dieser Kantenlänge gibt es keine Kurve: zwei volle Kerne der
// Mindest-Testbreite müssen hineinpassen.
const NOVELTY_MIN = 8;
// Kleinste Kernbreite, mit der die Kurve am Rand noch gezeichnet wird, und
// kleinste, mit der eine Spitze getestet wird: bei vier Abschnitten je Seite
// gibt es 35 verschiedene Aufteilungen, die beste hat p ≈ 0.03 — mit drei
// (zehn Aufteilungen) könnte keine Spitze je signifikant sein.
const KERNEL_MIN = 2;
const KERNEL_TEST_MIN = 4;
const KERNEL_MAX = 8;
// Tor „hat das Buch eine Ordnung": so viele zufällige Lesereihenfolgen muss das
// Nachbarschaftsband schlagen (p < 0.01). Kosten: Runden × m × w Zellen.
const ORDER_ROUNDS = 99;
// Lokaler Test je Spitze: zufällige Aufteilungen des Fensters, Signifikanzniveau.
const SPLIT_SAMPLES = 199;
const ALPHA = 0.05;
// Effektstärke: eine Bruchstelle muss mindestens diesen Anteil der stärksten
// tragen. Der lokale Test allein lässt in einem langen, gleichförmigen Teil
// jede zwanzigste Rausch-Spitze durch (viele Spitzen, je 5 %); deren Stärke
// liegt aber weit unter der eines echten Themenwechsels.
const RELATIVE_MIN = 0.35;
const BOUNDARY_TOP_K = 10;
const ECHO_TOP_K = 10;
// Ein Echo muss zusätzlich deutlich über dem typischen Paar seiner Art liegen
// (robuster z-Wert über alle zulässigen Paare), sonst füllte reines Rauschen
// die Liste, sobald benachbarte Abschnitte sich kaum ähneln.
const ECHO_MIN_Z = 2;
const MAD_SCALE = 1.4826;
const MIN_MAD = 0.005;

/**
 * Kernbreite (Abschnitte je Seite des Schachbretts) aus der Matrixgrösse: breit
 * genug, dass ein einzelner abweichender Abschnitt keine Bruchstelle macht,
 * schmal genug, dass zwei Brüche im selben Kapitel getrennt bleiben.
 */
function kernelWidth(m) {
  return Math.max(KERNEL_TEST_MIN, Math.min(KERNEL_MAX, Math.round(m / 12)));
}

/**
 * Matrix der zentrierten Cosinus-Ähnlichkeiten in Lesereihenfolge.
 *
 * ZENTRIERT: verglichen werden die Vektoren minus Buch-Schwerpunkt. Roh lägen
 * alle Paare eines Buchs über 80 % (gemeinsame Richtung „deutscher Roman"), und
 * die Matrix wäre eine gleichförmige helle Fläche. Zentriert heisst eine Zelle:
 * „teilen diese zwei, was sie vom Rest des Buchs abhebt" — sie kann negativ sein.
 *
 * @param {Array<{id:number, vector:Float32Array}>} points  in Lesereihenfolge
 * @returns {Promise<{ size:number, bins:number[][], data:Float32Array }>}
 *   `bins[i]` = Abschnitts-IDs der Zeile i (ein Element, solange das Buch unter
 *   `maxSize` bleibt), `data` = size×size, symmetrisch, Diagonale 1.
 */
async function similarityMatrix(points, { maxSize = MATRIX_MAX, onStep = null } = {}) {
  const n = points.length;
  if (!n) return { size: 0, bins: [], data: new Float32Array(0) };
  const dim = points[0].vector.length;
  const binSize = Math.ceil(n / maxSize);
  const groups = [];
  for (let i = 0; i < n; i += binSize) groups.push(points.slice(i, i + binSize));

  const mean = sumVectors(points, dim);
  for (let i = 0; i < dim; i++) mean[i] /= n;
  const rows = groups.map(g => {
    const s = sumVectors(g, dim);
    for (let i = 0; i < dim; i++) s[i] = s[i] / g.length - mean[i];
    return unit(s);
  });

  const m = groups.length;
  const data = new Float32Array(m * m);
  for (let i = 0; i < m; i++) {
    data[i * m + i] = 1;
    const a = rows[i];
    for (let j = i + 1; j < m; j++) {
      const b = rows[j];
      const s = a && b ? dot(a, b) : 0;
      data[i * m + j] = s;
      data[j * m + i] = s;
    }
    if (onStep && i % 50 === 49) await onStep();
  }
  return { size: m, bins: groups.map(g => g.map(p => p.id)), data };
}

// Mittel der Zellen eines Blocks [r0,r1)×[c0,c1); `offDiag` lässt die
// Diagonale aus (innerhalb eines Blocks auf der Diagonale wäre sie immer 1).
// `ix` bildet Zeilen-/Spaltennummer auf die Matrix ab (Identität oder eine
// Permutation für den Nulltest).
function _blockMean(data, m, ix, r0, r1, c0, c1, offDiag) {
  let s = 0;
  let k = 0;
  for (let r = r0; r < r1; r++) {
    const rr = ix[r] * m;
    for (let c = c0; c < c1; c++) {
      if (offDiag && r === c) continue;
      s += data[rr + ix[c]];
      k++;
    }
  }
  return k ? s / k : null;
}

function _noveltyWith(data, m, w, ix) {
  const out = new Array(m).fill(null);
  if (m < NOVELTY_MIN) return out;
  for (let i = 1; i < m; i++) {
    const k = Math.min(w, i, m - i);
    if (k < KERNEL_MIN) continue;
    const before = _blockMean(data, m, ix, i - k, i, i - k, i, true);
    const after = _blockMean(data, m, ix, i, i + k, i, i + k, true);
    const cross = _blockMean(data, m, ix, i - k, i, i, i + k, false);
    out[i] = (before + after) / 2 - cross;
  }
  return out;
}

const _identity = (m) => Array.from({ length: m }, (_, i) => i);

/**
 * Novelty-Kurve: `out[i]` bewertet die Grenze VOR Zeile i — mittlere
 * Ähnlichkeit innerhalb der Blöcke davor und danach minus Ähnlichkeit über die
 * Grenze hinweg. Hoch heisst: die Abschnitte davor gehören zusammen, die danach
 * auch, aber die beiden Gruppen nicht. Am Rand schrumpft der Kern; unter
 * Breite 2 bleibt der Wert null (kein Paar innerhalb eines Blocks).
 */
function novelty(data, m, w = kernelWidth(m)) {
  return _noveltyWith(data, m, w, _identity(m));
}

function _lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function _shuffleRange(ix, from, to, rnd) {
  for (let i = to - 1; i > from; i--) {
    const j = from + Math.floor(rnd() * (i - from + 1));
    const t = ix[i]; ix[i] = ix[j]; ix[j] = t;
  }
}

// Mittlere Ähnlichkeit im Band 1 ≤ |i−j| ≤ w unter der Zuordnung `ix`.
function _bandMean(data, m, w, ix) {
  let s = 0;
  let k = 0;
  for (let i = 0; i < m; i++) {
    const rr = ix[i] * m;
    for (let j = i + 1; j <= Math.min(m - 1, i + w); j++) { s += data[rr + ix[j]]; k++; }
  }
  return k ? s / k : 0;
}

/**
 * Hat das Buch überhaupt eine Ordnung? Nachbarn (Abstand bis zur Kernbreite)
 * müssen sich ähnlicher sein als in JEDER von `rounds` zufälligen
 * Lesereihenfolgen desselben Buchs. Ein Buch, dessen Abschnitte gleichförmig
 * oder im steten Wechsel sind, hat dann keine Bruchstellen — eine Novelty-Kurve
 * hat aber immer Spitzen, und ohne dieses Tor stünden sie als Befund da.
 */
function hasSequentialStructure(data, m, w = kernelWidth(m), { rounds = ORDER_ROUNDS } = {}) {
  if (m < NOVELTY_MIN) return false;
  const observed = _bandMean(data, m, w, _identity(m));
  const rnd = _lcg(0x9e3779b1);
  for (let r = 0; r < rounds; r++) {
    const ix = _identity(m);
    _shuffleRange(ix, 0, m, rnd);
    if (_bandMean(data, m, w, ix) >= observed) return false;
  }
  return true;
}

// p-Wert einer Spitze: wie oft trennt eine zufällige Aufteilung DERSELBEN 2k
// Abschnitte des Fensters mindestens so gut wie die tatsächliche Reihenfolge?
// Lokal statt über das ganze Buch: in einem Buch mit zwei klaren Themen
// erzeugen zufällige Gesamtreihenfolgen selbst kurze „AAAA|BBBB"-Läufe, ein
// globaler Nulltest läge darum über jeder echten Spitze.
function _splitPValue(data, m, i, k, observed, rnd, samples = SPLIT_SAMPLES) {
  const ix = _identity(m);
  let atLeast = 0;
  for (let r = 0; r < samples; r++) {
    _shuffleRange(ix, i - k, i + k, rnd);
    const before = _blockMean(data, m, ix, i - k, i, i - k, i, true);
    const after = _blockMean(data, m, ix, i, i + k, i, i + k, true);
    const cross = _blockMean(data, m, ix, i - k, i, i, i + k, false);
    if ((before + after) / 2 - cross >= observed - 1e-12) atLeast++;
  }
  return (1 + atLeast) / (1 + samples);
}

/**
 * Bruchstellen: lokale Spitzen der Novelty-Kurve, die (1) in einem Buch mit
 * Ordnung liegen (`hasSequentialStructure`), (2) ihr Fenster signifikant
 * besser teilen als zufällige Aufteilungen derselben Abschnitte (p ≤ ALPHA)
 * und (3) mindestens RELATIVE_MIN der stärksten solchen Spitze erreichen.
 * Getestet wird nur mit vollem Kern ab Breite KERNEL_TEST_MIN — mit weniger
 * Abschnitten je Seite gibt es zu wenige Aufteilungen, als dass eine
 * signifikant sein könnte. Zwei Spitzen näher als die Kernbreite sind derselbe
 * Bruch; es bleibt die höhere. Deterministisch geseedet.
 *
 * @returns {Array<{ix:number, score:number}>} absteigend nach `score`
 */
function boundaries(data, m, curve, { w = kernelWidth(m), topK = BOUNDARY_TOP_K, alpha = ALPHA } = {}) {
  if (!hasSequentialStructure(data, m, w)) return [];
  const rnd = _lcg(0x85ebca6b);
  const cands = [];
  for (let i = 0; i < curve.length; i++) {
    const v = curve[i];
    const k = Math.min(w, i, m - i);
    if (v == null || !(v > 0) || k < KERNEL_TEST_MIN) continue;
    // Lokale Spitze: kein Nachbar innerhalb der Kernbreite liegt höher.
    let peak = true;
    for (let j = Math.max(0, i - w + 1); j < Math.min(curve.length, i + w); j++) {
      if (j !== i && curve[j] != null && curve[j] > v) { peak = false; break; }
    }
    if (!peak) continue;
    if (_splitPValue(data, m, i, k, v, rnd) > alpha) continue;
    cands.push({ ix: i, score: v });
  }
  cands.sort((a, b) => b.score - a.score || a.ix - b.ix);
  const floor = cands.length ? cands[0].score * RELATIVE_MIN : 0;
  const kept = [];
  for (const c of cands) {
    if (c.score < floor) break;
    if (kept.some(k => Math.abs(k.ix - c.ix) < w)) continue;
    kept.push(c);
    if (kept.length >= topK) break;
  }
  return kept;
}

/**
 * Echos: Paare, zwischen denen ein ANDERER Teil liegt — sie gehören zu
 * Abschnitten (`segments`, aus den Bruchstellen), die mindestens zwei Brüche
 * auseinanderliegen —, und die sich trotzdem mindestens so ähnlich sind wie
 * benachbarte Abschnitte im Mittel (Median der Nebendiagonale). „Hier kehrt das
 * Buch zu etwas Früherem zurück." Ein Paar über nur EINE Bruchstelle hinweg
 * wäre kein Echo, sondern ein schwacher Bruch. Benachbarte Paare (beide
 * Koordinaten innerhalb der Kernbreite eines schon gewählten) sind dasselbe
 * Echo und fallen weg.
 *
 * @param {number[]} segments  Teil-Nummer je Zeile (aufsteigend)
 * @returns {Array<{a:number, b:number, score:number}>} a < b, absteigend
 */
function echoes(data, m, segments, { w = KERNEL_MIN, topK = ECHO_TOP_K, minZ = ECHO_MIN_Z } = {}) {
  if (!Array.isArray(segments) || segments.length !== m || m < 3) return [];
  const adjacent = [];
  for (let i = 1; i < m; i++) adjacent.push(data[(i - 1) * m + i]);
  const floor = median(adjacent);
  const all = [];
  for (let a = 0; a < m; a++) {
    for (let b = a + 1; b < m; b++) if (segments[b] - segments[a] >= 2) all.push(data[a * m + b]);
  }
  if (all.length < 3) return [];
  const med = median(all);
  const mad = Math.max(MIN_MAD, median(all.map(v => Math.abs(v - med))) * MAD_SCALE);
  const thr = Math.max(floor, med + minZ * mad, 0);
  const cands = [];
  for (let a = 0; a < m; a++) {
    for (let b = a + 1; b < m; b++) {
      if (segments[b] - segments[a] < 2) continue;
      const s = data[a * m + b];
      if (s >= thr) cands.push({ a, b, score: s });
    }
  }
  cands.sort((x, y) => y.score - x.score || x.a - y.a || x.b - y.b);
  const kept = [];
  for (const c of cands) {
    if (kept.some(k => Math.abs(k.a - c.a) < w && Math.abs(k.b - c.b) < w)) continue;
    kept.push(c);
    if (kept.length >= topK) break;
  }
  return kept;
}

/**
 * Oberes Dreieck (inkl. Diagonale) als Bytes: s ∈ [-1, 1] → 0..255. Auflösung
 * knapp ein Prozentpunkt — mehr unterscheidet keine Farbskala, und das Dreieck
 * halbiert die Nutzlast gegenüber der vollen Matrix.
 */
function encodeUpperTriangle(data, m) {
  const out = new Uint8Array((m * (m + 1)) / 2);
  let k = 0;
  for (let i = 0; i < m; i++) {
    for (let j = i; j < m; j++) {
      const s = Math.max(-1, Math.min(1, data[i * m + j]));
      out[k++] = Math.round((s + 1) * 127.5);
    }
  }
  return out;
}

/** Teil-Nummer je Zeile: steigt an jeder Bruchstelle um eins. */
function segmentsFrom(bounds, m) {
  const cuts = new Set(bounds.map(b => b.ix));
  const out = new Array(m);
  let seg = 0;
  for (let i = 0; i < m; i++) {
    if (cuts.has(i)) seg++;
    out[i] = seg;
  }
  return out;
}

module.exports = {
  similarityMatrix, novelty, hasSequentialStructure, boundaries, segmentsFrom, echoes,
  encodeUpperTriangle, kernelWidth, MATRIX_MAX,
};
