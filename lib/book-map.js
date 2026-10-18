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
// PCA-Achsen haben keine vorgegebene Bedeutung — was sie trennen, zeigt die
// Karte über die Abschnitte an ihren Polen (und auf Wunsch über eine KI-
// Benennung, Job `book-map-label`). Wer Achsen mit fester Bedeutung will,
// wählt Pol-Achsen (`poleProjection`: Figur gegen Figur, Ort gegen Ort,
// Begriff gegen Begriff). Der Anteil der Streuung, den eine Achse trägt, wird
// in beiden Fällen ausgewiesen; bei einem kleinen Wert ist die Karte eine
// schwache Skizze und muss das zugeben, statt Nähe zu behaupten, die im
// Vollraum nicht existiert. Alle Kennzahlen (Kohäsion, Nachbarschaft,
// Ausreisser, Matrix) werden deshalb im VOLLRAUM gerechnet, nie auf den
// 2D-Koordinaten.
//
// Aufteilung: Vektor-Helfer lib/book-map/vec.js, Projektionen
// lib/book-map/project.js, Ähnlichkeitsmatrix + Bruchstellen + Echos
// lib/book-map/matrix.js. Diese Datei verdichtet die Punkte, rechnet die
// Kapitel-Kennzahlen und re-exportiert den Rest.

const { unit, dot, cosToRaw, sumVectors, median } = require('./book-map/vec');
const project = require('./book-map/project');
const matrix = require('./book-map/matrix');

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
    const u = unit(e.sum);
    if (!u) continue;
    points.push({ id, chapterId: e.chapterId, chunks: e.count, vector: u });
  }
  // Stabile Reihenfolge: die Projektion soll bei gleicher Eingabe gleich
  // herauskommen, und Map-Iteration hängt an der Einfüge-Reihenfolge der Query.
  points.sort((a, b) => a.id - b.id);
  return { points };
}

/**
 * Ein Punkt je PASSAGE (Chunk) statt je Abschnitt — für lange Abschnitte, deren
 * Mittelwert alles Charakteristische wegmittelt und zur Buchmitte zieht. Gleiche
 * Filter wie `preparePoints`. Sprungziel bleibt der Abschnitt (`id`), `ix` ist
 * die Passage darin. Reihenfolge: Abschnitts-ID, dann Passage.
 *
 * @param {Array<{entity_id:number, chunk_ix:number, chapter_id:number|null, text:string, vector:Float32Array}>} chunks
 * @returns {Array<{id:number, ix:number, chapterId:number|null, vector:Float32Array}>}
 */
function prepareChunkPoints(chunks, { minChars = MIN_CHARS } = {}) {
  const out = [];
  let dim = 0;
  for (const c of chunks || []) {
    if (String(c.text == null ? '' : c.text).trim().length < minChars) continue;
    const v = c.vector;
    if (!v || !v.length) continue;
    if (!dim) dim = v.length;
    if (v.length !== dim) continue;
    const u = unit(v);
    if (!u) continue;
    out.push({ id: c.entity_id, ix: c.chunk_ix ?? 0, chapterId: c.chapter_id ?? null, vector: u });
  }
  out.sort((a, b) => a.id - b.id || a.ix - b.ix);
  return out;
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

  const bookMean = sumVectors(points, dim);
  for (let i = 0; i < dim; i++) bookMean[i] /= points.length;

  const sums = new Map();
  const centered = new Map();
  for (const [cid, group] of byChapter) {
    const sum = sumVectors(group, dim);
    sums.set(cid, sum);
    const c = new Float64Array(dim);
    for (let i = 0; i < dim; i++) c[i] = sum[i] / group.length - bookMean[i];
    const u = unit(c);
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
      const sims = group.map(p => (dot(p.vector, sum) - 1) / (n - 1));
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
        const s = dot(own, other);
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
  const centroid = sumVectors(group, dim);
  let a = 0;
  let aSim = Infinity;
  group.forEach((p, i) => { const s = cosToRaw(p.vector, centroid); if (s < aSim) { aSim = s; a = i; } });
  let b = a === 0 ? 1 : 0;
  let bSim = Infinity;
  group.forEach((p, i) => { if (i === a) return; const s = dot(p.vector, group[a].vector); if (s < bSim) { bSim = s; b = i; } });

  let cA = Float64Array.from(group[a].vector);
  let cB = Float64Array.from(group[b].vector);
  let assign = new Array(n).fill(-1);
  for (let it = 0; it < SPLIT_ITERS; it++) {
    let changed = false;
    const next = group.map(p => (cosToRaw(p.vector, cA) >= cosToRaw(p.vector, cB) ? 0 : 1));
    for (let i = 0; i < n; i++) if (next[i] !== assign[i]) { changed = true; break; }
    assign = next;
    if (!changed) break;
    cA = sumVectors(group.filter((_, i) => assign[i] === 0), dim);
    cB = sumVectors(group.filter((_, i) => assign[i] === 1), dim);
  }

  const idxA = [];
  const idxB = [];
  assign.forEach((g, i) => (g === 0 ? idxA : idxB).push(i));
  if (idxA.length < minGroup || idxB.length < minGroup) return null;

  const sumA = sumVectors(idxA.map(i => group[i]), dim);
  const sumB = sumVectors(idxB.map(i => group[i]), dim);
  const rest = new Float64Array(dim);
  let silSum = 0;
  for (let i = 0; i < n; i++) {
    const p = group[i].vector;
    const ownSum = assign[i] === 0 ? sumA : sumB;
    const otherSum = assign[i] === 0 ? sumB : sumA;
    for (let k = 0; k < dim; k++) rest[k] = ownSum[k] - p[k];
    const da = 1 - cosToRaw(p, rest);
    const db = 1 - cosToRaw(p, otherSum);
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
  const centroid = unit(sumVectors(points, dim));
  if (!centroid) return [];
  const rows = points.map(p => ({ id: p.id, chapterId: p.chapterId, distance: 1 - dot(p.vector, centroid) }));
  const med = median(rows.map(r => r.distance));
  const mad = Math.max(MIN_MAD, median(rows.map(r => Math.abs(r.distance - med))) * MAD_SCALE);
  return rows
    .filter(r => (r.distance - med) / mad >= minZ)
    .sort((x, y) => y.distance - x.distance)
    .slice(0, topK);
}

module.exports = {
  preparePoints, prepareChunkPoints, chapterStats, splitChapter, outliers, MIN_CHARS,
  unitVector: unit,
  ...project,
  ...matrix,
};
