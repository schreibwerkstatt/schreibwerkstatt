'use strict';
// Buchlandkarte-Job: projiziert die Vektoren des Embedding-Index in die Ebene,
// rechnet die Ähnlichkeitsmatrix in Lesereihenfolge und die Kennzahlen
// (Kapitel-Kohaesion, Nachbar-Kapitel, Ausreisser, Bruchstellen, Echos) —
// Mathematik in lib/book-map.js.
//
// Rein rueckwaertsgewandt: liest den bestehenden `semantic_chunks`-Index, ruft
// KEIN KI-Backend und schreibt NIE in den Buchtext. Das Embedding-Backend wird
// nur fuer Freitext-Pole gerufen (ein Query-Vektor je Begriff). Setzt einen
// gebauten Index voraus (embed-index-Job); ohne Chunks → leeres Ergebnis.
//
// Optionen (Body):
//   granularity  'page' (Default) | 'chunk' — Punkte der Karte je Abschnitt oder
//                je Passage. Matrix, Kapitel-Kennzahlen und Ausreisser bleiben
//                immer auf Abschnitts-Ebene.
//   poles        null (Default: PCA, drei Komponenten) | { x: [A, B], y: [C, D] | null }
//                mit Pol = { kind: 'figure'|'location', id } | { kind: 'text', text }.
//
// WARUM EIN JOB UND KEINE ROUTE (anders als `GET /search/semantic`): Power-
// Iteration und Matrix laufen ueber ALLE Punkte × Dimension. Bei 4000 Seiten und
// dim=1024 sind das gut eine Milliarde Multiplikationen — genug, um den
// Single-Process-Server sekundenlang anzuhalten. Der Job gibt darum regelmaessig
// an den Event-Loop zurueck und prueft dort den Abbruch, gleiche Ueberlegung wie
// beim Redundanz-Radar.
//
// Das ERGEBNIS wird nicht persistiert: es ist vollstaendig aus dem Index neu
// berechenbar, und ein Ableitungs-Index eines Ableitungs-Index waere nur eine
// weitere Stelle, die veralten kann.

const crypto = require('crypto');
const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError, jsonBody, jobAbortControllers,
  startBookJob,
} = require('./shared');
const embed = require('../../lib/embed');
const contentStore = require('../../lib/content-store');
const semanticChunks = require('../../db/semantic-chunks');
const { toIntId } = require('../../lib/validate');
const bm = require('../../lib/book-map');

const bookMapRouter = express.Router();

// Obergrenze der projizierten Seiten. Schuetzt vor pathologisch grossen Buechern;
// wird sie ueberschritten, verarbeiten wir die ersten MAX_POINTS in
// Lesereihenfolge und melden es ehrlich (`result.truncatedPages`), statt still
// einen Teil der Karte zu verschweigen.
const MAX_POINTS = 4000;
// Obergrenze der Passagen-Punkte. Darueber wird gleichmaessig ausgeduennt (jede
// k-te Passage in Lesereihenfolge), nicht abgeschnitten: das Buchende soll auf
// der Karte so vertreten sein wie der Anfang.
const MAX_CHUNK_POINTS = 6000;
// Wieviele Ausreisser-Seiten die Karte auflistet. Mehr liest niemand, und die
// Aussage „das passt nicht ins Buch" verwaessert mit jeder Zeile.
const OUTLIER_TOP_K = 12;
const POLE_TEXT_MAX = 200;
const GRANULARITIES = new Set(['page', 'chunk']);
const ENTITY_POLE_KINDS = new Set(['figure', 'location']);

const _yield = () => new Promise(r => setImmediate(r));
const _round = (v) => (v == null ? null : Math.round(v * 1000) / 1000);

// Seiten des Buchs in Lesereihenfolge (Content-Store, book_order-SSoT):
// page_id → { pos, updatedAt }. Die Position orientiert die Achsen (fruehe
// Seiten links/unten), ordnet die Matrix und bestimmt, welche Seiten beim
// Deckel bleiben; die Zeitstempel zaehlen die seit dem letzten Index-Lauf
// geaenderten Seiten.
async function _pageOrder(bookId, userEmail) {
  const tree = await contentStore.bookTree(bookId, { userEmail });
  const order = new Map();
  contentStore.flattenTree(tree).forEach((r, pos) => {
    order.set(Number(r.page.id), { pos, updatedAt: r.page.updated_at || null });
  });
  return order;
}

function _parsePole(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (ENTITY_POLE_KINDS.has(raw.kind)) {
    const id = toIntId(raw.id);
    return id ? { kind: raw.kind, id } : null;
  }
  if (raw.kind === 'text') {
    const text = String(raw.text == null ? '' : raw.text).trim();
    return text && text.length <= POLE_TEXT_MAX ? { kind: 'text', text } : null;
  }
  return null;
}

function _parsePair(raw) {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const a = _parsePole(raw[0]);
  const b = _parsePole(raw[1]);
  return a && b ? [a, b] : null;
}

/**
 * Body → Optionen oder `{ error: feld }`. Exportiert fuer den Unit-Test.
 */
function parseBookMapOptions(body) {
  const granularity = body?.granularity == null ? 'page' : body.granularity;
  if (!GRANULARITIES.has(granularity)) return { error: 'granularity' };
  let poles = null;
  if (body?.poles != null) {
    const x = _parsePair(body.poles.x);
    if (!x) return { error: 'poles' };
    let y = null;
    if (body.poles.y != null) {
      y = _parsePair(body.poles.y);
      if (!y) return { error: 'poles' };
    }
    poles = { x, y };
  }
  return { granularity, poles };
}

function _optionsKey(opts) {
  if (opts.granularity === 'page' && !opts.poles) return '';
  const h = crypto.createHash('sha1').update(JSON.stringify(opts)).digest('hex').slice(0, 12);
  return ':' + h;
}

// Pol → Einheitsvektor + Anzeige-Label. Figur/Ort: gemittelter Index-Vektor mit
// Besitzpruefung im SQL; Freitext: ein Query-Vektor. Fehlt ein Pol (geloescht,
// fremd, nicht indiziert), bricht der Lauf mit einem lesbaren Fehler ab — eine
// Achse mit stillschweigend ersetztem Pol waere eine falsche Beschriftung.
async function _resolvePole(pole, { bookId, userEmail, model, candidates, signal }) {
  if (pole.kind === 'text') {
    const v = await embed.embedQuery(pole.text, { signal });
    const u = v && bm.unitVector(v);
    if (!u) throw i18nError('job.error.bookMapPoleMissing', { name: pole.text });
    return { vector: u, label: pole.text };
  }
  const name = candidates.find(c => c.kind === pole.kind && c.id === pole.id)?.name || `#${pole.id}`;
  const raw = semanticChunks.loadPoleVector(bookId, userEmail, model, pole.kind, pole.id);
  const u = raw && bm.unitVector(raw);
  if (!u) throw i18nError('job.error.bookMapPoleMissing', { name });
  return { vector: u, label: name };
}

// Passagen-Punkte in Lesereihenfolge, gleichmaessig ausgeduennt ueber dem Deckel.
function _chunkPoints(chunks, pos, keepPages) {
  let pts = bm.prepareChunkPoints(chunks).filter(p => keepPages.has(p.id));
  pts.sort((a, b) => pos(a.id) - pos(b.id) || a.id - b.id || a.ix - b.ix);
  const found = pts.length;
  if (pts.length > MAX_CHUNK_POINTS) {
    const step = pts.length / MAX_CHUNK_POINTS;
    const thinned = [];
    for (let k = 0; k < MAX_CHUNK_POINTS; k++) thinned.push(pts[Math.floor(k * step)]);
    pts = thinned;
  }
  return { points: pts, thinned: found - pts.length };
}

async function runBookMapJob(jobId, bookId, userEmail, opts = { granularity: 'page', poles: null }) {
  const logger = makeJobLogger(jobId);
  try {
    if (!embed.isEnabled()) throw i18nError('job.error.embedDisabled');
    const { model } = embed.getConfig();
    const signal = jobAbortControllers.get(jobId)?.signal;
    const abortIfCancelled = () => {
      if (jobAbortControllers.get(jobId)?.signal?.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
    };
    const step = async () => { await _yield(); abortIfCancelled(); };

    updateJob(jobId, { statusText: 'job.phase.bookMapLoad', progress: 5 });
    const order = await _pageOrder(bookId, userEmail);
    const chunks = semanticChunks.loadPageChunksWithChapter(bookId, model);
    const lastIndexedAt = semanticChunks.lastIndexedAt(bookId, model);
    const candidates = semanticChunks.listPoleCandidates(bookId, userEmail, model);
    await step();

    const pos = (id) => order.get(id)?.pos ?? Number.MAX_SAFE_INTEGER;
    let { points } = bm.preparePoints(chunks);
    points.sort((a, b) => pos(a.id) - pos(b.id) || a.id - b.id);
    const foundPages = points.length;
    let truncatedPages = 0;
    if (points.length > MAX_POINTS) {
      truncatedPages = points.length - MAX_POINTS;
      points = points.slice(0, MAX_POINTS);
      logger.warn(`Buchlandkarte ${bookId}: ${foundPages} Seiten > Cap ${MAX_POINTS} → ${truncatedPages} uebersprungen.`);
    }

    // Punkte der Karte: Abschnitte oder Passagen.
    let mapPoints = points;
    let thinnedChunks = 0;
    if (opts.granularity === 'chunk') {
      const r = _chunkPoints(chunks, pos, new Set(points.map(p => p.id)));
      mapPoints = r.points;
      thinnedChunks = r.thinned;
    }
    logger.info(`Buchlandkarte ${bookId}: ${points.length} Seiten, ${mapPoints.length} Kartenpunkte (${opts.granularity}${opts.poles ? ', Pole' : ''}), Modell ${model}.`);

    // ── Projektion ──
    updateJob(jobId, { statusText: 'job.phase.bookMapProject', progress: 20 });
    await step();
    let projection;
    if (opts.poles) {
      const ctx = { bookId, userEmail, model, candidates, signal };
      const pairs = [opts.poles.x, ...(opts.poles.y ? [opts.poles.y] : [])];
      const resolved = [];
      for (const [a, b] of pairs) {
        resolved.push([await _resolvePole(a, ctx), await _resolvePole(b, ctx)]);
        abortIfCancelled();
      }
      const pp = bm.poleProjection(mapPoints, resolved.map(([a, b]) => [a.vector, b.vector]));
      if (!pp && mapPoints.length >= 3) throw i18nError('job.error.bookMapPoleSame');
      projection = {
        mode: 'poles',
        values: pp ? bm.scaleCommon(pp.values) : [],
        axes: resolved.map(([a, b], k) => ({
          kind: 'pole', variance: _round(pp ? pp.variances[k] : 0), poles: [a.label, b.label],
        })),
      };
    } else {
      // Fortschritt 20 → 68 ueber die Runden der drei Komponenten (hoechstens
      // 3 × POWER_ITERS; konvergiert es frueher, springt der Balken weiter).
      let n = 0;
      const pca = await bm.projectAsync(mapPoints, {
        orient: mapPoints.map(p => pos(p.id) + (p.ix || 0) / 1e4),
        components: 3,
        onStep: async () => {
          n++;
          if (n % 10 === 0) updateJob(jobId, { progress: Math.min(68, 20 + Math.round(n * 0.27)) });
          await step();
        },
      });
      projection = {
        mode: 'pca',
        values: bm.scaleCommon(pca.values),
        axes: pca.variances.map(v => ({ kind: 'pc', variance: _round(v) })),
      };
    }

    // ── Matrix in Lesereihenfolge ──
    updateJob(jobId, { statusText: 'job.phase.bookMapMatrix', progress: 70 });
    await step();
    const mx = await bm.similarityMatrix(points, { onStep: step });
    const w = bm.kernelWidth(mx.size);
    const curve = bm.novelty(mx.data, mx.size, w);
    const bounds = bm.boundaries(mx.data, mx.size, curve, { w });
    const echoList = bm.echoes(mx.data, mx.size, bm.segmentsFrom(bounds, mx.size), { w });

    updateJob(jobId, { statusText: 'job.phase.bookMapStats', progress: 90 });
    await step();
    const chapters = bm.chapterStats(points);
    const far = bm.outliers(points, { topK: OUTLIER_TOP_K });

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

    const pca = projection.mode === 'pca';
    const result = {
      model,
      options: opts,
      pages: points.map(p => ({ id: p.id, chapterId: p.chapterId, chunks: p.chunks })),
      projection: {
        mode: projection.mode,
        granularity: opts.granularity,
        axes: projection.axes,
        points: mapPoints.map((p, i) => ({
          id: p.id,
          chapterId: p.chapterId,
          ix: opts.granularity === 'chunk' ? p.ix : null,
          c: projection.values.map(vs => _round(vs[i])),
        })),
        thinned: thinnedChunks,
      },
      matrix: {
        size: mx.size,
        bins: mx.bins,
        data: Buffer.from(bm.encodeUpperTriangle(mx.data, mx.size)).toString('base64'),
        kernel: w,
        novelty: curve.map(_round),
        boundaries: bounds.map(b => ({ ix: b.ix, score: _round(b.score) })),
        echoes: echoList.map(e => ({ a: e.a, b: e.b, score: _round(e.score) })),
      },
      poleCandidates: candidates,
      chapters: chapters.map(c => ({
        ...c,
        cohesion: _round(c.cohesion),
        spread: _round(c.spread),
        nearestScore: _round(c.nearestScore),
        split: c.split ? { silhouette: _round(c.split.silhouette), groups: c.split.groups } : null,
      })),
      outliers: far.map(o => ({ ...o, distance: _round(o.distance) })),
      // Anteil der ersten zwei PCA-Achsen; bei Pol-Achsen gibt es keinen
      // Summenwert (die zwei Richtungen sind nicht orthogonal).
      explainedVariance: pca ? _round(Math.min(1, (projection.axes[0]?.variance || 0) + (projection.axes[1]?.variance || 0))) : null,
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

bookMapRouter.post('/book-map', jsonBody, (req, res) => {
  const opts = parseBookMapOptions(req.body);
  if (opts.error) return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: opts.error } });
  return startBookJob(req, res, {
    type: 'book-map',
    minRole: 'lektor',
    label: 'job.label.bookMap',
    // Je Optionssatz ein eigener Lauf: ein laufender PCA-Job darf einen
    // Pol-Lauf nicht als „schon unterwegs" verschlucken.
    dedupId: (id) => `${id}${_optionsKey(opts)}`,
    precheck: () => (embed.isEnabled() ? null : 'EMBED_DISABLED'),
    run: (jobId, { bookId, userEmail }) => runBookMapJob(jobId, bookId, userEmail, opts),
  });
});

module.exports = { bookMapRouter, runBookMapJob, parseBookMapOptions };
