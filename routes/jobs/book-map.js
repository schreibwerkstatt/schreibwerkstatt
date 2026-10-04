'use strict';
// Buchlandkarte-Job: projiziert die Seiten-Vektoren des Embedding-Index in zwei
// Dimensionen und rechnet die Kennzahlen (Kapitel-Kohaesion, Nachbar-Kapitel,
// Ausreisser-Seiten) — Mathematik in lib/book-map.js.
//
// Rein rueckwaertsgewandt: liest den bestehenden `semantic_chunks`-Index, ruft
// KEIN Embedding- und KEIN KI-Backend und schreibt NIE in den Buchtext. Setzt
// einen gebauten Index voraus (embed-index-Job); ohne Chunks → leeres Ergebnis.
//
// WARUM EIN JOB UND KEINE ROUTE (anders als `GET /search/semantic`): die
// Power-Iteration laeuft ueber ALLE Punkte × Dimension × Iterationen. Bei 4000
// Seiten und dim=1024 sind das gut eine Milliarde Multiplikationen — genug, um
// den Single-Process-Server sekundenlang anzuhalten. Der Job gibt darum nach
// JEDER Runde der Iteration an den Event-Loop zurueck (`project2dAsync`) und
// prueft dort den Abbruch, gleiche Ueberlegung wie beim Redundanz-Radar.
//
// Das ERGEBNIS ist klein (ein Punkt je Seite, zwei Zahlen) und wird nicht
// persistiert: es ist vollstaendig aus dem Index neu berechenbar, und ein
// Ableitungs-Index eines Ableitungs-Index waere nur eine weitere Stelle, die
// veralten kann.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, jsonBody, jobAbortControllers,
  startBookJob,
} = require('./shared');
const embed = require('../../lib/embed');
const contentStore = require('../../lib/content-store');
const semanticChunks = require('../../db/semantic-chunks');
const { preparePoints, project2dAsync, chapterStats, outliers } = require('../../lib/book-map');

const bookMapRouter = express.Router();

// Nur Seiten. Szenen/Figuren sind kurze Meta-Steckbriefe — sie lagen in einer
// gemeinsamen Projektion als eigener Klumpen neben dem Buch und haetten die
// Achsen dominiert, ohne etwas ueber den Text zu sagen (gleiche Begruendung wie
// die KINDS-Wahl des Redundanz-Radars).
const KINDS = ['page'];
// Obergrenze der projizierten Seiten. Schuetzt vor pathologisch grossen Buechern;
// wird sie ueberschritten, verarbeiten wir die ersten MAX_POINTS in
// Lesereihenfolge und melden es
// ehrlich (`result.truncatedPages`), statt still einen Teil der Karte zu
// verschweigen.
const MAX_POINTS = 4000;
// Wieviele Ausreisser-Seiten die Karte auflistet. Mehr liest niemand, und die
// Aussage „das passt nicht ins Buch" verwaessert mit jeder Zeile.
const OUTLIER_TOP_K = 12;

const _yield = () => new Promise(r => setImmediate(r));

// Seiten des Buchs in Lesereihenfolge (Content-Store, book_order-SSoT):
// page_id → { pos, updatedAt }. Die Position orientiert die Achsen (fruehe
// Seiten links/unten) und bestimmt, welche Seiten beim Deckel bleiben; die
// Zeitstempel zaehlen die seit dem letzten Index-Lauf geaenderten Seiten.
async function _pageOrder(bookId, userEmail) {
  const tree = await contentStore.bookTree(bookId, { userEmail });
  const order = new Map();
  contentStore.flattenTree(tree).forEach((r, pos) => {
    order.set(Number(r.page.id), { pos, updatedAt: r.page.updated_at || null });
  });
  return order;
}

async function runBookMapJob(jobId, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    if (!embed.isEnabled()) throw i18nError('job.error.embedDisabled');
    const { model } = embed.getConfig();
    const abortIfCancelled = () => {
      if (jobAbortControllers.get(jobId)?.signal?.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
    };

    updateJob(jobId, { statusText: 'job.phase.bookMapLoad', progress: 5 });
    const order = await _pageOrder(bookId, userEmail);
    const chunks = semanticChunks.loadPageChunksWithChapter(bookId, model);
    const lastIndexedAt = semanticChunks.lastIndexedAt(bookId, model);
    await _yield();
    abortIfCancelled();

    const pos = (id) => order.get(id)?.pos ?? Number.MAX_SAFE_INTEGER;
    let { points } = preparePoints(chunks);
    points.sort((a, b) => pos(a.id) - pos(b.id) || a.id - b.id);
    const foundPages = points.length;
    let truncatedPages = 0;
    if (points.length > MAX_POINTS) {
      truncatedPages = points.length - MAX_POINTS;
      points = points.slice(0, MAX_POINTS);
      logger.warn(`Buchlandkarte ${bookId}: ${foundPages} Seiten > Cap ${MAX_POINTS} → ${truncatedPages} uebersprungen.`);
    }
    logger.info(`Buchlandkarte ${bookId}: ${points.length} Seiten-Punkte, Modell ${model}.`);

    updateJob(jobId, { statusText: 'job.phase.bookMapProject', progress: 30 });
    await _yield();
    abortIfCancelled();
    // Fortschritt 30 → 78 ueber die Runden beider Komponenten (hoechstens
    // 2 × POWER_ITERS; konvergiert es frueher, springt der Balken weiter).
    let step = 0;
    const { coords, explainedVariance } = await project2dAsync(points, {
      orient: points.map(p => pos(p.id)),
      onStep: async () => {
        step++;
        if (step % 10 === 0) updateJob(jobId, { progress: Math.min(78, 30 + Math.round(step * 0.4)) });
        await _yield();
        abortIfCancelled();
      },
    });

    updateJob(jobId, { statusText: 'job.phase.bookMapStats', progress: 80 });
    await _yield();
    abortIfCancelled();
    const chapters = chapterStats(points);
    const far = outliers(points, { topK: OUTLIER_TOP_K });

    // Index-Stand fuer die Karte: wie viele Seiten des Buchs fehlen (leer, zu
    // kurz, noch nicht indiziert) und wie viele seit dem letzten Lauf
    // geaendert wurden — ihr Punkt zeigt den alten Text.
    const onMap = new Set(points.map(p => p.id));
    let stalePages = 0;
    if (lastIndexedAt) {
      for (const [id, o] of order) {
        if (onMap.has(id) && o.updatedAt && o.updatedAt > lastIndexedAt) stalePages++;
      }
    }

    const round = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
    const result = {
      model,
      pages: points.map((p, i) => ({
        id: p.id,
        chapterId: p.chapterId,
        x: round(coords[i][0]),
        y: round(coords[i][1]),
        chunks: p.chunks,
      })),
      chapters: chapters.map(c => ({
        ...c,
        cohesion: round(c.cohesion),
        spread: round(c.spread),
        nearestScore: round(c.nearestScore),
        split: c.split ? { silhouette: round(c.split.silhouette), groups: c.split.groups } : null,
      })),
      outliers: far.map(o => ({ ...o, distance: round(o.distance) })),
      explainedVariance: round(explainedVariance),
      truncatedPages,
      totalPages: order.size,
      missingPages: Math.max(0, order.size - foundPages),
      stalePages,
      lastIndexedAt,
      computedAt: new Date().toISOString(),
    };

    updateJob(jobId, { progress: 98 });
    completeJob(jobId, result, null, `${result.pages.length} Seiten · ${result.chapters.length} Kapitel`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Buchlandkarte Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

bookMapRouter.post('/book-map', jsonBody, (req, res) => startBookJob(req, res, {
  type: 'book-map',
  minRole: 'lektor',
  label: 'job.label.bookMap',
  precheck: () => (embed.isEnabled() ? null : 'EMBED_DISABLED'),
  run: (jobId, { bookId, userEmail }) => runBookMapJob(jobId, bookId, userEmail),
}));

module.exports = { bookMapRouter, runBookMapJob };
