'use strict';
// Redundanz-Radar-Job: findet buchweite Doppelungen, indem er alle Seiten-Chunks
// des Embedding-Index paarweise per Cosinus vergleicht (lib/redundancy.js). Rein
// rückwärtsgewandt — liest den bestehenden semantic_chunks-Index, ruft KEIN
// Embedding-/KI-Backend und schreibt NIE in den Buchtext. Setzt einen gebauten
// Semantik-Index voraus (embed-index-Job); ohne Chunks → leeres Ergebnis.
//
// Der O(n²)-Scan läuft blockweise mit Yield an den Event-Loop, damit er den
// Single-Process-Server auch bei grossen Büchern nicht einfriert. Das Ergebnis
// landet zusätzlich in redundancy_runs (letzter Lauf pro Buch und User); vom
// User ignorierte Paare (redundancy_dismissals) fallen schon im Scan heraus.
// Lese-/Ignorier-Routen: routes/redundancy.js. Doku: docs/redundanz.md.

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, jsonBody, jobAbortControllers,
  startBookJob,
} = require('./shared');
const embed = require('../../lib/embed');
const appSettings = require('../../lib/app-settings');
const contentStore = require('../../lib/content-store');
const semanticChunks = require('../../db/semantic-chunks');
const redundancyDb = require('../../db/redundancy');
const {
  FIGURE_DUPE_THRESHOLD, prepare, scanBlock, pairsBefore, nextBlockEnd, finalizePairs, findFigureDuplicates,
} = require('../../lib/redundancy');

const redundancyRouter = express.Router();

// Nur Seiten vergleichen (Prosa-Doppelungen). Szenen/Figuren sind kurze Meta-
// Steckbriefe, deren Ähnlichkeit erwartbar/rauschig ist.
const KINDS = ['page'];
// Schwelle-Bandbreite (bge-m3-Cosinus): darunter/darüber sinnlos → geclampt.
// Dieselben Grenzen validiert die App-Setting-Registry (redundancy.threshold_*).
const MIN_THRESHOLD = 0.70;
const MAX_THRESHOLD = 0.97;
// Obergrenze verglichener Chunks. Schützt vor pathologisch grossen Büchern; wird
// sie überschritten, verarbeiten wir die ersten MAX_CHUNKS in Buchreihenfolge und
// melden es ehrlich (result.truncatedChunks), statt still Befunde zu verschlucken.
const MAX_CHUNKS = 6000;
const TOP_K = 60;
// Paare pro Scan-Block, danach einmal an den Event-Loop zurückgeben. Bei
// ~1000 Dimensionen sind das einige zehn Millisekunden pro Block.
const PAIR_BUDGET = 40000;
const FIGURE_TOP_K = 40;

const _yield = () => new Promise(r => setImmediate(r));

// Seiten des Buchs in Lesereihenfolge (Content-Store, book_order-SSoT):
// page_id → { pos, chapterId }. Nur was hier steht, nimmt am Vergleich teil —
// Chunks gelöschter oder in ein anderes Buch verschobener Seiten halten ihre
// Vektoren bis zum nächsten Reindex und dürfen nicht als Befund auftauchen.
async function _pageOrder(bookId, userEmail) {
  const tree = await contentStore.bookTree(bookId, { userEmail });
  const order = new Map();
  contentStore.flattenTree(tree).forEach((r, pos) => {
    order.set(Number(r.page.id), { pos, chapterId: r.chapterId ?? null });
  });
  return order;
}

async function runRedundancyJob(jobId, bookId, opts, userEmail) {
  const { threshold, skipAdjacent } = opts;
  const logger = makeJobLogger(jobId);
  try {
    if (!embed.isEnabled()) throw i18nError('job.error.embedDisabled');
    const { model } = embed.getConfig();

    updateJob(jobId, { statusText: 'job.phase.redundancyLoad', progress: 5 });
    const order = await _pageOrder(bookId, userEmail);
    const chunks = semanticChunks.loadChunksForPairing(bookId, model, KINDS)
      .filter(c => order.has(Number(c.entity_id)))
      .sort((x, y) => (order.get(Number(x.entity_id)).pos - order.get(Number(y.entity_id)).pos) || (x.chunk_ix - y.chunk_ix));

    // Erst filtern (zu kurz / Nullvektor), dann kappen: sonst belegten
    // unvergleichbare Chunks Plätze unter dem Cap.
    let { vecs, metas } = prepare(chunks);
    let truncatedChunks = 0;
    if (vecs.length > MAX_CHUNKS) {
      truncatedChunks = vecs.length - MAX_CHUNKS;
      vecs = vecs.slice(0, MAX_CHUNKS);
      metas = metas.slice(0, MAX_CHUNKS);
      logger.warn(`Redundanz ${bookId}: ${truncatedChunks + MAX_CHUNKS} Chunks > Cap ${MAX_CHUNKS} → ${truncatedChunks} übersprungen.`);
    }
    const n = vecs.length;
    logger.info(`Redundanz ${bookId}: ${n} vergleichbare Seiten-Chunks, Schwelle ${threshold}, Nachbarn ${skipAdjacent ? 'aus' : 'an'}.`);

    const dismissed = redundancyDb.dismissalSets(bookId, userEmail);
    // Direkt aufeinanderfolgende Seiten im selben Kapitel (eine Szene über zwei
    // Seiten) ranken naturgemäss hoch und verdrängen echte Doppelungen aus der
    // Top-Liste — auf Wunsch kein Befund.
    const skipPair = (a, b) => {
      if (dismissed.page.has(a + ':' + b)) return true;
      if (!skipAdjacent) return false;
      const pa = order.get(Number(a));
      const pb = order.get(Number(b));
      return Math.abs(pa.pos - pb.pos) === 1 && pa.chapterId === pb.chapterId;
    };

    const best = new Map();
    let comparedPairs = 0;
    const totalPairs = Math.max(pairsBefore(n, n), 1);
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    for (let i = 0; i < n;) {
      if (signal()?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      const end = nextBlockEnd(n, i, PAIR_BUDGET);
      comparedPairs += scanBlock(vecs, metas, i, end, threshold, best, { skipPair });
      updateJob(jobId, {
        statusText: 'job.phase.redundancyScan',
        statusParams: { done: end, total: n },
        progress: 10 + Math.round((pairsBefore(n, end) / totalPairs) * 85),
      });
      i = end;
      await _yield();
    }

    const { pairs, totalFound, truncated } = finalizePairs(best, metas, { topK: TOP_K });

    // Figuren-Dubletten (billiger Zusatz-Abschnitt: ein Vektor pro Figur). Rein
    // rückwärtsgewandt — Signal an den Autor, kein Auto-Merge. Non-fatal: ein
    // Fehler hier verwirft nie das Seiten-Ergebnis.
    updateJob(jobId, { statusText: 'job.phase.redundancyFigures', progress: 97 });
    let figures = { pairs: [], totalFound: 0, truncated: false, figuresCompared: 0, threshold: FIGURE_DUPE_THRESHOLD };
    try {
      const figVecs = semanticChunks.loadFigureVectorsForPairing(bookId, userEmail, model);
      const figRes = figVecs.length >= 2
        ? findFigureDuplicates(figVecs, {
          topK: FIGURE_TOP_K, skipPair: (a, b) => dismissed.figure.has(a + ':' + b),
        })
        : { pairs: [], totalFound: 0, truncated: false };
      figures = { ...figRes, figuresCompared: figVecs.length, threshold: FIGURE_DUPE_THRESHOLD };
    } catch (e) {
      logger.warn(`Figuren-Dubletten übersprungen (${bookId}): ${e.message}`);
    }

    const result = {
      model, threshold, skipAdjacent, comparedChunks: n, comparedPairs,
      totalFound, truncated, truncatedChunks, pairs, figures,
      // Index-Stand, gegen den gerechnet wurde: die Karte vergleicht ihn mit
      // dem aktuellen und weist auf ein veraltetes Ergebnis hin.
      indexedAt: semanticChunks.lastIndexedAt(bookId, model),
      createdAt: new Date().toISOString(),
    };
    // Letztes Ergebnis behalten, damit die Karte beim nächsten Öffnen nicht leer
    // steht. Non-fatal: das Ergebnis geht trotzdem an den wartenden Poller.
    try {
      redundancyDb.saveRun(bookId, userEmail, threshold, result);
    } catch (e) {
      logger.warn(`Redundanz-Ergebnis nicht gespeichert (${bookId}): ${e.message}`);
    }

    updateJob(jobId, { progress: 98 });
    completeJob(jobId, result, null, `${totalFound} Passagen-Paar(e) · ${figures.totalFound} Figuren-Paar(e)`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Redundanz-Radar Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

function _clampThreshold(raw) {
  const t = Number(raw);
  const fallback = Number(appSettings.get('redundancy.threshold_medium'));
  const v = Number.isFinite(t) ? t : (Number.isFinite(fallback) ? fallback : 0.82);
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, v));
}

redundancyRouter.post('/redundancy', jsonBody, (req, res) => startBookJob(req, res, {
  type: 'redundancy', minRole: 'lektor', label: 'job.label.redundancy',
  precheck: () => (embed.isEnabled() ? null : 'EMBED_DISABLED'),
  run: (jobId, { bookId, userEmail }) => runRedundancyJob(jobId, bookId, {
    threshold: _clampThreshold(req.body?.threshold),
    skipAdjacent: req.body?.skip_adjacent !== false,
  }, userEmail),
}));

module.exports = { redundancyRouter, runRedundancyJob, MIN_THRESHOLD, MAX_THRESHOLD };
