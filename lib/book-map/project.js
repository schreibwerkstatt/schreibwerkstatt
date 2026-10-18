'use strict';
// Projektionen der Buchlandkarte: PCA (bis drei Komponenten) und Pol-Achsen.
// Re-exportiert von lib/book-map.js — Begründung der Verfahrenswahl dort im
// Kopfkommentar.
//
// Beide Projektionen rechnen dieselbe Grösse: die Lage eines zentrierten Punkts
// entlang einer Einheitsrichtung im Vollraum. PCA sucht die Richtungen der
// grössten Streuung, eine Pol-Achse nimmt die Richtung von Pol B nach Pol A
// (zwei Figuren, zwei Schauplätze, zwei Begriffe). Darum lassen sich beide mit
// demselben Mass ausweisen: welchen Anteil der Gesamtstreuung trägt die Achse.

const POWER_ITERS = 60;
// Abbruch, wenn sich der Eigenvektor kaum mehr dreht: 1 − |cos(alt, neu)|.
// Ein Winkel-Kriterium hängt — anders als eine über alle Komponenten summierte
// Differenz — nicht an der Dimension; bei dim=1024 lief die Summe sonst
// praktisch immer alle POWER_ITERS Runden durch.
const POWER_EPS = 1e-10;
// Mehr als drei Komponenten liest niemand: die Karte bietet die Achsenpaare
// 1/2, 1/3 und 2/3 an, jede weitere Komponente trägt bei Prosa nur noch
// Bruchteile eines Prozents.
const MAX_COMPONENTS = 3;

// Deterministischer Startvektor der Power-Iteration. KEIN Math.random(): die
// Karte muss bei gleicher Eingabe gleich herauskommen, und im Workflow-Kontext
// ist Math.random ohnehin verboten. Ein konstanter Vektor (alle 1) kann exakt im
// Nullraum liegen; das gestreute Muster unten ist gegen diesen Sonderfall robust
// und hängt nur von der Dimension ab.
function _seed(dim) {
  const v = new Float64Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin((i + 1) * 0.7391) + 0.1;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

/**
 * Grösste Eigenrichtung der Kovarianz von `rows` (zentriert) per Power-Iteration.
 * `rows` wird nicht verändert. Generator: gibt nach jeder Runde ab (`yield`),
 * damit der Job den Event-Loop freigeben und Abbrüche prüfen kann. Rückgabe
 * `{ dir }` — `dir` normiert oder null.
 */
function* _topComponent(rows, dim) {
  const v = _seed(dim);
  const next = new Float64Array(dim);
  for (let it = 0; it < POWER_ITERS; it++) {
    next.fill(0);
    // next = Σ_i row_i · (row_i · v)  — Kovarianz-Produkt ohne die d×d-Matrix
    // je aufzubauen (bei dim=1024 wären das 1M Zellen pro Komponente).
    for (const row of rows) {
      let p = 0;
      for (let i = 0; i < dim; i++) p += row[i] * v[i];
      if (p === 0) continue;
      for (let i = 0; i < dim; i++) next[i] += row[i] * p;
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += next[i] * next[i];
    norm = Math.sqrt(norm);
    if (!(norm > 0)) return { dir: null };
    let cos = 0;
    for (let i = 0; i < dim; i++) {
      const nv = next[i] / norm;
      cos += nv * v[i];
      v[i] = nv;
    }
    if (1 - Math.abs(cos) < POWER_EPS) break;
    yield;
  }
  return { dir: v };
}

/**
 * Schwerpunkt und Gesamtstreuung (Summe der quadrierten Abstände zum
 * Schwerpunkt) — der Nenner jedes Varianzanteils.
 */
function centerStats(points) {
  const dim = points[0].vector.length;
  const mean = new Float64Array(dim);
  for (const p of points) for (let i = 0; i < dim; i++) mean[i] += p.vector[i];
  for (let i = 0; i < dim; i++) mean[i] /= points.length;
  let total = 0;
  for (const p of points) {
    for (let i = 0; i < dim; i++) { const c = p.vector[i] - mean[i]; total += c * c; }
  }
  return { mean, total, dim };
}

// Lage jedes Punkts entlang der Einheitsrichtung `dir` (zentriert) und der
// Anteil der Gesamtstreuung, den diese Richtung trägt. EXAKT aus den
// Projektionen gerechnet, nicht aus einem Eigenwert-Schätzer der Iteration —
// der wäre ohne volle Konvergenz zu hoch, und dieser Wert entscheidet, ob die
// Karte sich „belastbar" nennt.
function _along(points, mean, total, dir) {
  const dim = mean.length;
  const values = points.map(p => {
    let s = 0;
    for (let i = 0; i < dim; i++) s += (p.vector[i] - mean[i]) * dir[i];
    return s;
  });
  let shown = 0;
  for (const v of values) shown += v * v;
  return { values, variance: total > 0 ? Math.min(1, shown / total) : 0 };
}

/**
 * PCA als Generator — gibt nach jeder Runde der Power-Iteration ab.
 *
 * @returns {{ values: number[][], variances: number[] }} `values[k][i]` ist die
 *   Lage von Punkt i auf Komponente k (roh, nicht skaliert), `variances[k]` ihr
 *   Anteil an der Gesamtstreuung. Bei weniger als drei Punkten: alle 0.
 *
 * `orient` (optional, je Punkt eine Zahl, z.B. die Buch-Position) legt das
 * Vorzeichen jeder Achse fest; siehe `_orientSign`.
 */
function* _projectSteps(points, { orient = null, components = 2 } = {}) {
  const k = Math.max(1, Math.min(MAX_COMPONENTS, components));
  const n = points.length;
  const zeros = () => ({
    values: Array.from({ length: k }, () => points.map(() => 0)),
    variances: Array.from({ length: k }, () => 0),
  });
  if (n < 3) return zeros();
  const { mean, total, dim } = centerStats(points);

  // Zentrieren (PCA ohne Zentrierung findet die Richtung zum Schwerpunkt, nicht
  // die Richtung der grössten Streuung).
  const rows = points.map(p => {
    const r = new Float64Array(dim);
    for (let i = 0; i < dim; i++) r[i] = p.vector[i] - mean[i];
    return r;
  });

  const values = [];
  const variances = [];
  for (let c = 0; c < k; c++) {
    const comp = yield* _topComponent(rows, dim);
    if (!comp.dir) break;
    const a = _along(points, mean, total, comp.dir);
    _flipInPlace(a.values, _orientSign(a.values, orient));
    values.push(a.values);
    variances.push(a.variance);
    // Deflation: Komponente aus den Zeilen entfernen, dann dieselbe Iteration
    // erneut → nächste Komponente, orthogonal zu den vorigen.
    if (c < k - 1) {
      for (const r of rows) {
        let p = 0;
        for (let i = 0; i < dim; i++) p += r[i] * comp.dir[i];
        for (let i = 0; i < dim; i++) r[i] -= p * comp.dir[i];
      }
    }
  }
  if (!values.length) return zeros();
  while (values.length < k) { values.push(points.map(() => 0)); variances.push(0); }
  return { values, variances };
}

function _run(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

async function _runAsync(gen, onStep) {
  let r = gen.next();
  while (!r.done) {
    if (onStep) await onStep();
    r = gen.next();
  }
  return r.value;
}

/**
 * Zwei-Komponenten-PCA der Punkte (synchron).
 *
 * @returns {{ coords: Array<[number, number]>, explainedVariance: number }}
 *   `coords[i]` gehört zu `points[i]`, skaliert auf [-1, 1] (die Achsen haben
 *   keine Einheit, nur die relative Lage zählt). `explainedVariance` ist der
 *   Anteil der Gesamtstreuung, den die zwei Achsen zeigen — 0 bei zu wenigen
 *   Punkten.
 */
function project2d(points, { orient = null } = {}) {
  return _to2d(_run(_projectSteps(points, { orient, components: 2 })));
}

/**
 * Wie `project2d`, ruft aber nach jeder Runde der Power-Iteration `onStep`
 * (darf async sein und werfen — z.B. Event-Loop freigeben, Abbruch prüfen).
 * Bei 4000 Seiten × dim 1024 hielte ein synchroner Durchlauf den Server
 * sekundenlang an.
 */
async function project2dAsync(points, { orient = null, onStep = null } = {}) {
  return _to2d(await _runAsync(_projectSteps(points, { orient, components: 2 }), onStep));
}

/** PCA mit bis zu drei Komponenten, async wie `project2dAsync`. */
async function projectAsync(points, { orient = null, components = MAX_COMPONENTS, onStep = null } = {}) {
  return _runAsync(_projectSteps(points, { orient, components }), onStep);
}

function _to2d({ values, variances }) {
  return {
    coords: _scaleToUnitBox(values[0], values[1]),
    explainedVariance: Math.min(1, variances[0] + variances[1]),
  };
}

/**
 * Pol-Achsen: je Paar (A, B) die Lage jedes Punkts entlang der Richtung von B
 * nach A. Positiv heisst „näher an A als an B", die Achse trägt damit eine
 * Bedeutung, die der Autor selbst gewählt hat — anders als eine PCA-Achse.
 *
 * Die Richtung ist die Differenz der zwei Einheitsvektoren. Was beide Pole
 * gemeinsam haben (Sprache, Textsorte eines Figuren-Steckbriefs), hebt sich
 * dabei auf; übrig bleibt, worin sie sich unterscheiden.
 *
 * @param {Array<{vector:Float32Array}>} points  Einheitsvektoren
 * @param {Array<[Float32Array, Float32Array]>} pairs  je Achse [A, B], Einheitsvektoren
 * @returns {{ values: number[][], variances: number[] } | null}  null, wenn ein
 *   Paar keine Richtung hat (A = B) oder zu wenige Punkte da sind.
 */
function poleProjection(points, pairs) {
  if (points.length < 3 || !pairs.length) return null;
  const { mean, total } = centerStats(points);
  const values = [];
  const variances = [];
  for (const [a, b] of pairs) {
    const dir = new Float64Array(a.length);
    let norm = 0;
    for (let i = 0; i < a.length; i++) { dir[i] = a[i] - b[i]; norm += dir[i] * dir[i]; }
    if (!(norm > 1e-12)) return null;
    norm = Math.sqrt(norm);
    for (let i = 0; i < dir.length; i++) dir[i] /= norm;
    const r = _along(points, mean, total, dir);
    values.push(r.values);
    variances.push(r.variance);
  }
  return { values, variances };
}

// Vorzeichen einer Achse festlegen. Eine Eigenrichtung ist nur bis aufs
// Vorzeichen bestimmt; ohne Regel kann schon eine kleine Textänderung die Karte
// spiegeln, und der Autor findet seine Kapitel nicht wieder.
//   - mit `orient` (Buch-Position je Punkt): die Achse läuft mit dem Buch —
//     frühe Seiten links bzw. unten.
//   - ohne oder bei Gleichstand: die Schiefe entscheidet (der lange Ausläufer
//     der Wolke zeigt nach rechts bzw. oben).
function _orientSign(values, orient) {
  if (Array.isArray(orient) && orient.length === values.length) {
    let mo = 0;
    for (const o of orient) mo += o;
    mo /= orient.length;
    let corr = 0;
    for (let i = 0; i < values.length; i++) corr += values[i] * (orient[i] - mo);
    if (Math.abs(corr) > 1e-12) return corr < 0 ? -1 : 1;
  }
  let skew = 0;
  for (const v of values) skew += v * v * v;
  return skew < 0 ? -1 : 1;
}

function _flipInPlace(values, sign) {
  if (sign < 0) for (let i = 0; i < values.length; i++) values[i] = -values[i];
}

// Beide Achsen mit DEMSELBEN Faktor auf [-1,1] bringen. Getrennt skaliert wären
// die Abstände verzerrt und eine gestreckte Wolke sähe rund aus — genau die
// Aussage, die die Karte machen soll, wäre dahin.
function _scaleToUnitBox(xs, ys) {
  let max = 0;
  for (let i = 0; i < xs.length; i++) {
    max = Math.max(max, Math.abs(xs[i]), Math.abs(ys[i]));
  }
  const f = max > 0 ? 1 / max : 0;
  return xs.map((x, i) => [x * f + 0, ys[i] * f + 0]);
}

/**
 * Mehrere Achsen desselben Raums mit EINEM gemeinsamen Faktor auf [-1, 1]
 * bringen — gleiche Begründung wie `_scaleToUnitBox`, für die Job-Ausgabe, aus
 * der das Frontend beliebige Achsenpaare wählt.
 */
function scaleCommon(valueArrays) {
  let max = 0;
  for (const vs of valueArrays) for (const v of vs) max = Math.max(max, Math.abs(v));
  const f = max > 0 ? 1 / max : 0;
  return valueArrays.map(vs => vs.map(v => v * f + 0));
}

module.exports = {
  project2d, project2dAsync, projectAsync, poleProjection, centerStats, scaleCommon, MAX_COMPONENTS,
};
