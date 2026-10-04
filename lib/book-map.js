'use strict';
// Buchlandkarte: die Punktwolke des Embedding-Index als Geometrie lesen, statt
// sie nur abzufragen. Reiner Ableitungs-Schritt über `semantic_chunks` — kein
// Embedding-Call, kein KI-Call, keine DB-/Netz-Abhängigkeit (→ unit-testbar,
// tests/unit/book-map.test.mjs).
//
// Alle bisherigen Konsumenten des Index stellen dieselbe Frage: „gib mir die k
// nächsten Nachbarn zu diesem Text". Hier wird die Wolke als GANZES ausgewertet,
// und das beantwortet drei Fragen, für die eine Trefferliste das falsche Werkzeug
// ist:
//
//   1. WO LIEGEN DIE KAPITEL ZUEINANDER — zwei Kapitel, deren Wolken
//      übereinanderliegen, erzählen dasselbe.
//   2. HÄLT EIN KAPITEL ZUSAMMEN — ein Kapitel, das in zwei Wolken zerfällt, ist
//      ein Teilungsvorschlag, den kein anderes Feature machen kann.
//   3. WAS PASST NICHT INS BUCH — die Seite mit dem grössten Abstand zum
//      Buch-Zentroid ist der eingeschobene Exkurs, der Blindtext, die vergessene
//      Notizseite.
//
// ── Warum PCA und kein t-SNE/UMAP ──────────────────────────────────────────
// PCA ist eine LINEARE Projektion und damit deterministisch, parameterfrei und
// in ~40 Zeilen selbst gerechnet (Power-Iteration mit Deflation). Nachbarschafts-
// Verfahren wie t-SNE/UMAP sähen hübscher aus, brauchen aber eine Vendor-Lib,
// haben Hyperparameter (Perplexity), sind zufallsinitialisiert — und ihre
// ABSTÄNDE sind bedeutungslos: sie erhalten lokale Nachbarschaft und erfinden
// dafür globale Struktur. Genau die globale Struktur ist hier aber die Frage.
// Zusätzlich zählt Determinismus: dieselbe Analyse muss beim zweiten Öffnen
// dasselbe Bild zeigen (gleiche Regel wie bei der Wortwolke).
//
// ── Was die Karte NICHT ist ────────────────────────────────────────────────
// Die zwei Achsen haben keine Bedeutung und bekommen darum auch keine
// Beschriftung — nur die relative Lage zählt. Die erklärte Varianz
// (`explainedVariance`) sagt, wie viel von der Wolke die Projektion überhaupt
// zeigt; bei einem kleinen Wert ist die Karte eine schwache Skizze und muss das
// zugeben, statt Nähe zu behaupten, die im Vollraum nicht existiert. Alle
// Kennzahlen (Kohäsion, Nachbarschaft, Ausreisser) werden deshalb im VOLLRAUM
// gerechnet, nie auf den 2D-Koordinaten.

const POWER_ITERS = 60;
// Abbruch, wenn sich der Eigenvektor kaum mehr dreht: 1 − |cos(alt, neu)|.
// Ein Winkel-Kriterium hängt — anders als eine über alle Komponenten summierte
// Differenz — nicht an der Dimension; bei dim=1024 lief die Summe sonst
// praktisch immer alle POWER_ITERS Runden durch.
const POWER_EPS = 1e-10;
// Sehr kurze Chunks (blosse Überschrift, ein Satz) liegen im Vektorraum
// verrauscht und würden die Wolke ausbeulen, ohne Inhalt zu tragen. Gleiche
// Schwelle und gleiche Begründung wie im Redundanz-Radar.
const MIN_CHARS = 40;
// Teilungs-Test: erst ab so vielen Seiten — darunter ist jede Zweiteilung
// Zufall, und „Kapitel mit vier Seiten zerfällt" wäre Rauschen mit Ausrufezeichen.
const SPLIT_MIN_PAGES = 6;
// Jede Hälfte braucht mindestens so viele Seiten; eine abgespaltene Einzelseite
// ist ein Ausreisser, kein zweites Thema.
const SPLIT_MIN_GROUP = 2;
// Mittlere Silhouette, ab der eine Zweiteilung als Struktur gilt. 0.25 ist die
// klassische Untergrenze für „schwache, aber echte Struktur" (Kaufman &
// Rousseeuw); 2-Means findet in jeder Wolke IRGENDEINE Teilung, deren
// Silhouette auf reinem Rauschen knapp über null liegt.
const SPLIT_MIN_SILHOUETTE = 0.25;
const SPLIT_ITERS = 20;
// Ausreisser: robuster z-Wert (Median/MAD) über die Abstände zum Buch-Zentroid.
// Robust, weil Mittelwert und Standardabweichung von genau den Ausreissern
// verzogen würden, die sie finden sollen. 1.4826 macht die MAD bei
// Normalverteilung zur Standardabweichung.
const OUTLIER_MIN_Z = 2.5;
const MAD_SCALE = 1.4826;
// Untergrenze der (skalierten) MAD. Liegen fast alle Seiten praktisch
// deckungsgleich, geht die MAD gegen null, und jede Rundungs-Abweichung bekäme
// einen riesigen z-Wert. Unter einem halben Prozentpunkt Cosinus-Abstand ist
// Streuung kein Befund.
const MIN_MAD = 0.005;

// ── Vorbereitung ────────────────────────────────────────────────────────────

/**
 * Chunks zu Entitäts-Vektoren verdichten: ein Punkt je Seite (Mittel über ihre
 * Chunks), auf Einheitslänge normiert. Chunks unter `minChars` oder mit
 * Nullvektor fallen heraus; eine Seite, von der nichts übrig bleibt, ebenso.
 *
 * WARUM EIN PUNKT JE SEITE und nicht je Chunk: die Karte soll navigierbar sein
 * — ein Punkt muss ein Sprungziel haben. Zehn Punkte derselben Seite wären
 * zehnmal dasselbe Ziel und würden ausserdem lange Seiten überrepräsentieren.
 *
 * @param {Array<{entity_id:number, chapter_id:number|null, text:string, vector:Float32Array}>} chunks
 * @returns {{ points: Array<{id:number, chapterId:number|null, chunks:number, vector:Float32Array}> }}
 */
function preparePoints(chunks, { minChars = MIN_CHARS } = {}) {
  const acc = new Map(); // entity_id → { chapterId, sum, count, dim }
  for (const c of chunks || []) {
    const text = String(c.text == null ? '' : c.text);
    if (text.trim().length < minChars) continue;
    const v = c.vector;
    if (!v || !v.length) continue;
    let e = acc.get(c.entity_id);
    if (!e) {
      e = { chapterId: c.chapter_id ?? null, sum: new Float64Array(v.length), count: 0 };
      acc.set(c.entity_id, e);
    }
    if (v.length !== e.sum.length) continue; // Fremdmodell-Rest überspringen
    for (let i = 0; i < v.length; i++) e.sum[i] += v[i];
    e.count++;
  }

  const points = [];
  for (const [id, e] of acc) {
    if (!e.count) continue;
    const unit = _unit(e.sum);
    if (!unit) continue;
    points.push({ id, chapterId: e.chapterId, chunks: e.count, vector: unit });
  }
  // Stabile Reihenfolge: die Projektion soll bei gleicher Eingabe gleich
  // herauskommen, und Map-Iteration hängt an der Einfüge-Reihenfolge der Query.
  points.sort((a, b) => a.id - b.id);
  return { points };
}

// Vektor auf Einheitslänge; null bei Nullvektor.
function _unit(v) {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  if (!(norm > 0)) return null;
  const inv = 1 / Math.sqrt(norm);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

// Skalarprodukt. Auf Einheitsvektoren IST das der Cosinus — die Normierung in
// `preparePoints`/`_unit` ist die Voraussetzung dafür, dass hier keine Norm mehr
// pro Paar gerechnet werden muss.
function _dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Cosinus eines Einheitsvektors `u` zu einem beliebigen Vektor `v`; 0, wenn
// `v` der Nullvektor ist (keine Richtung → keine Ähnlichkeit).
function _cosToRaw(u, v) {
  let dot = 0;
  let norm = 0;
  for (let i = 0; i < v.length; i++) { dot += u[i] * v[i]; norm += v[i] * v[i]; }
  return norm > 0 ? dot / Math.sqrt(norm) : 0;
}

function _sumVectors(points, dim) {
  const sum = new Float64Array(dim);
  for (const p of points) for (let i = 0; i < dim; i++) sum[i] += p.vector[i];
  return sum;
}

// ── Projektion ──────────────────────────────────────────────────────────────

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
 * Zwei-Komponenten-PCA der Punkte als Generator — gibt nach jeder Runde der
 * Power-Iteration ab. `project2d` (synchron) und `project2dAsync` (Job) teilen
 * sich diesen Kern.
 *
 * `orient` (optional, je Punkt eine Zahl, z.B. die Buch-Position) legt das
 * Vorzeichen der Achsen fest; siehe `_orientSign`.
 */
function* _project2dSteps(points, { orient = null } = {}) {
  const n = points.length;
  if (n < 3) return { coords: points.map(() => [0, 0]), explainedVariance: 0 };
  const dim = points[0].vector.length;

  // Zentrieren (PCA ohne Zentrierung findet die Richtung zum Schwerpunkt, nicht
  // die Richtung der grössten Streuung).
  const mean = _sumVectors(points, dim);
  for (let i = 0; i < dim; i++) mean[i] /= n;
  const rows = points.map(p => {
    const r = new Float64Array(dim);
    for (let i = 0; i < dim; i++) r[i] = p.vector[i] - mean[i];
    return r;
  });

  let total = 0;
  for (const r of rows) for (let i = 0; i < dim; i++) total += r[i] * r[i];

  const first = yield* _topComponent(rows, dim);
  if (!first.dir) return { coords: points.map(() => [0, 0]), explainedVariance: 0 };

  // Deflation: erste Komponente aus den Zeilen entfernen, dann dieselbe
  // Iteration erneut → zweite Komponente, orthogonal zur ersten.
  for (const r of rows) {
    let p = 0;
    for (let i = 0; i < dim; i++) p += r[i] * first.dir[i];
    for (let i = 0; i < dim; i++) r[i] -= p * first.dir[i];
  }
  const second = yield* _topComponent(rows, dim);

  const xs = [];
  const ys = [];
  for (const p of points) {
    let x = 0;
    let y = 0;
    for (let i = 0; i < dim; i++) {
      const c = p.vector[i] - mean[i];
      x += c * first.dir[i];
      if (second.dir) y += c * second.dir[i];
    }
    xs.push(x);
    ys.push(y);
  }

  // Erklärte Varianz EXAKT aus den Projektionen: die Streuung, die die zwei
  // gezeigten Achsen tatsächlich tragen, geteilt durch die Gesamtstreuung. Ein
  // Eigenwert-Schätzer aus der Iteration wäre ohne volle Konvergenz zu hoch —
  // und dieser Wert entscheidet, ob die Karte sich „belastbar" nennt.
  let shown = 0;
  for (let i = 0; i < n; i++) shown += xs[i] * xs[i] + ys[i] * ys[i];
  const explained = total > 0 ? Math.min(1, shown / total) : 0;

  _flipInPlace(xs, _orientSign(xs, orient));
  _flipInPlace(ys, _orientSign(ys, orient));
  const coords = _scaleToUnitBox(xs, ys);
  return { coords, explainedVariance: explained };
}

function _run(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next();
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
function project2d(points, opts) {
  return _run(_project2dSteps(points, opts));
}

/**
 * Wie `project2d`, ruft aber nach jeder Runde der Power-Iteration `onStep`
 * (darf async sein und werfen — z.B. Event-Loop freigeben, Abbruch prüfen).
 * Bei 4000 Seiten × dim 1024 hielte ein synchroner Durchlauf den Server
 * sekundenlang an.
 */
async function project2dAsync(points, { orient = null, onStep = null } = {}) {
  const gen = _project2dSteps(points, { orient });
  let r = gen.next();
  while (!r.done) {
    if (onStep) await onStep();
    r = gen.next();
  }
  return r.value;
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

// ── Kennzahlen (alle im Vollraum) ───────────────────────────────────────────

/**
 * Je Kapitel: Kohäsion, Streuung, nächstes Kapitel und — ab SPLIT_MIN_PAGES
 * Seiten — ein Teilungsbefund.
 *
 * KOHÄSION IST KEIN GÜTEMASS. Ein niedriger Wert heisst „thematisch breit", und
 * das ist im Sachbuch-Übersichtskapitel richtig und im Szenen-Kapitel ein
 * Hinweis. Darum liefert die Funktion Zahlen und keine Urteile; die Deutung
 * bleibt beim Autor.
 *
 * KOHÄSION = MITTLERE PAAR-ÄHNLICHKEIT der Seiten eines Kapitels (jedes Paar
 * verschiedener Seiten), nicht Ähnlichkeit zum Kapitel-Schwerpunkt. Gegen einen
 * Schwerpunkt, in dem die Seite selbst steckt, sähen kleine Kapitel
 * geschlossener aus; gegen den Schwerpunkt der übrigen Seiten (Leave-one-out)
 * kippte es ins Gegenteil, weil ein Mittel aus vielen Seiten weniger rauscht als
 * eine einzelne Nachbarseite. Der Paar-Mittelwert hängt nicht an der
 * Kapitelgrösse und kostet über die Kapitelsumme trotzdem nur O(n·dim):
 * Σ_{i≠j} pᵢ·pⱼ = |S|² − n.
 *
 * NÄCHSTES KAPITEL ZENTRIERT: verglichen werden die Kapitel-Schwerpunkte MINUS
 * den Buch-Schwerpunkt. Embedding-Vektoren eines Buchs teilen eine starke
 * gemeinsame Richtung („deutscher Roman"); roh lägen alle Kapitel-Paare bei
 * über 90 %, und die Spalte unterschiede nichts. Zentriert heisst der Wert:
 * „worin sich diese zwei vom Rest des Buchs abheben, das teilen sie" — er kann
 * negativ werden.
 *
 * Kapitel mit weniger als zwei Seiten haben keine Streuung und bekommen
 * `cohesion: null` — ein Wert von 1.0 wäre die Behauptung perfekter Geschlossen-
 * heit, wo einfach nichts zu vergleichen war.
 *
 * @returns {Array<{chapterId, pages, cohesion, spread, nearestChapterId, nearestScore, split}>}
 */
function chapterStats(points) {
  const byChapter = new Map();
  for (const p of points) {
    if (p.chapterId == null) continue; // kapitellose Seite: kein Kapitel-Befund
    let g = byChapter.get(p.chapterId);
    if (!g) { g = []; byChapter.set(p.chapterId, g); }
    g.push(p);
  }
  if (!byChapter.size) return [];
  const dim = points[0].vector.length;

  const bookMean = _sumVectors(points, dim);
  for (let i = 0; i < dim; i++) bookMean[i] /= points.length;

  const sums = new Map();
  const centered = new Map();
  for (const [cid, group] of byChapter) {
    const sum = _sumVectors(group, dim);
    sums.set(cid, sum);
    const c = new Float64Array(dim);
    for (let i = 0; i < dim; i++) c[i] = sum[i] / group.length - bookMean[i];
    const u = _unit(c);
    if (u) centered.set(cid, u);
  }

  const out = [];
  for (const [cid, group] of byChapter) {
    let cohesion = null;
    let spread = null;
    if (group.length >= 2) {
      // Mittlere Ähnlichkeit einer Seite zu jeder ANDEREN Seite ihres
      // Kapitels: p·(S − p) / (n − 1), mit p·p = 1 für Einheitsvektoren.
      const sum = sums.get(cid);
      const n = group.length;
      const sims = group.map(p => (_dot(p.vector, sum) - 1) / (n - 1));
      cohesion = sims.reduce((a, b) => a + b, 0) / n;
      // Streuung als Abstand der entlegensten Seite zu den übrigen: das ist die
      // Zahl, die „eine Seite gehört nicht dazu" sichtbar macht — ein
      // Mittelwert allein verwischt sie.
      spread = 1 - Math.min(...sims);
    }
    let nearestChapterId = null;
    let nearestScore = null;
    const own = centered.get(cid);
    if (own) {
      for (const [otherId, other] of centered) {
        if (otherId === cid) continue;
        const s = _dot(own, other);
        if (nearestScore == null || s > nearestScore) { nearestScore = s; nearestChapterId = otherId; }
      }
    }
    out.push({
      chapterId: cid,
      pages: group.length,
      cohesion,
      spread,
      nearestChapterId,
      nearestScore,
      split: splitChapter(group),
    });
  }
  return out;
}

/**
 * Zerfällt das Kapitel in zwei Themen? 2-Means im Vollraum (Cosinus,
 * deterministisch geseedet), bewertet mit der mittleren Silhouette.
 *
 * Silhouette je Seite: a = Abstand zum Schwerpunkt der übrigen Seiten der
 * EIGENEN Gruppe, b = Abstand zum Schwerpunkt der anderen Gruppe,
 * s = (b − a) / max(a, b). Über Schwerpunkte statt über alle Paare gerechnet
 * (vereinfachte Silhouette) — O(n·dim) statt O(n²·dim), damit auch ein
 * 300-Seiten-Kapitel den Job nicht aufhält.
 *
 * @returns {{ silhouette:number, groups:[number[], number[]] } | null}
 *   `groups` sind Seiten-IDs, die kleinere ID zuerst; null, wenn das Kapitel
 *   zu klein ist oder keine Teilung die Schwelle erreicht.
 */
function splitChapter(group, {
  minPages = SPLIT_MIN_PAGES, minGroup = SPLIT_MIN_GROUP, minSilhouette = SPLIT_MIN_SILHOUETTE,
} = {}) {
  const n = group.length;
  if (n < minPages) return null;
  const dim = group[0].vector.length;

  // Seeds: die Seite am weitesten vom Kapitel-Schwerpunkt, dann die Seite am
  // weitesten von ihr. Deterministisch (bei Gleichstand die erste in
  // Eingabe-Reihenfolge) und ohne Zufall.
  const centroid = _sumVectors(group, dim);
  let a = 0;
  let aSim = Infinity;
  group.forEach((p, i) => { const s = _cosToRaw(p.vector, centroid); if (s < aSim) { aSim = s; a = i; } });
  let b = a === 0 ? 1 : 0;
  let bSim = Infinity;
  group.forEach((p, i) => { if (i === a) return; const s = _dot(p.vector, group[a].vector); if (s < bSim) { bSim = s; b = i; } });

  let cA = Float64Array.from(group[a].vector);
  let cB = Float64Array.from(group[b].vector);
  let assign = new Array(n).fill(-1);
  for (let it = 0; it < SPLIT_ITERS; it++) {
    let changed = false;
    const next = group.map(p => (_cosToRaw(p.vector, cA) >= _cosToRaw(p.vector, cB) ? 0 : 1));
    for (let i = 0; i < n; i++) if (next[i] !== assign[i]) { changed = true; break; }
    assign = next;
    if (!changed) break;
    cA = _sumVectors(group.filter((_, i) => assign[i] === 0), dim);
    cB = _sumVectors(group.filter((_, i) => assign[i] === 1), dim);
  }

  const idxA = [];
  const idxB = [];
  assign.forEach((g, i) => (g === 0 ? idxA : idxB).push(i));
  if (idxA.length < minGroup || idxB.length < minGroup) return null;

  const sumA = _sumVectors(idxA.map(i => group[i]), dim);
  const sumB = _sumVectors(idxB.map(i => group[i]), dim);
  const rest = new Float64Array(dim);
  let silSum = 0;
  for (let i = 0; i < n; i++) {
    const p = group[i].vector;
    const ownSum = assign[i] === 0 ? sumA : sumB;
    const otherSum = assign[i] === 0 ? sumB : sumA;
    for (let k = 0; k < dim; k++) rest[k] = ownSum[k] - p[k];
    const da = 1 - _cosToRaw(p, rest);
    const db = 1 - _cosToRaw(p, otherSum);
    const m = Math.max(da, db);
    silSum += m > 0 ? (db - da) / m : 0;
  }
  const silhouette = silSum / n;
  if (!(silhouette >= minSilhouette)) return null;

  const ids = (ix) => ix.map(i => group[i].id).sort((x, y) => x - y);
  const groups = [ids(idxA), ids(idxB)].sort((x, y) => x[0] - y[0]);
  return { silhouette, groups };
}

/**
 * Seiten, die deutlich weiter vom Buch-Zentroid entfernt liegen als der Rest —
 * „was passt hier nicht hinein". Absteigend nach Abstand, höchstens `topK`.
 *
 * „Deutlich" heisst: robuster z-Wert ≥ `minZ` (Median/MAD der Abstände). Ein
 * gleichförmiges Buch hat dann KEINE Ausreisser — eine feste Top-K-Liste
 * hätte auch dort zwölf Seiten als „passt nicht hinein" angeprangert.
 *
 * Der Abstand wird zum Zentroid ALLER Seiten gerechnet, nicht zum eigenen
 * Kapitel: die Frage ist „gehört das in dieses Buch", nicht „gehört das in
 * dieses Kapitel" (letzteres steckt in `chapterStats.spread`).
 */
function outliers(points, { topK = 10, minZ = OUTLIER_MIN_Z } = {}) {
  if (points.length < 3) return [];
  const dim = points[0].vector.length;
  const centroid = _unit(_sumVectors(points, dim));
  if (!centroid) return [];
  const rows = points.map(p => ({ id: p.id, chapterId: p.chapterId, distance: 1 - _dot(p.vector, centroid) }));
  const med = _median(rows.map(r => r.distance));
  const mad = Math.max(MIN_MAD, _median(rows.map(r => Math.abs(r.distance - med))) * MAD_SCALE);
  return rows
    .filter(r => (r.distance - med) / mad >= minZ)
    .sort((x, y) => y.distance - x.distance)
    .slice(0, topK);
}

function _median(values) {
  const s = [...values].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

module.exports = {
  preparePoints, project2d, project2dAsync, chapterStats, splitChapter, outliers, MIN_CHARS,
};
