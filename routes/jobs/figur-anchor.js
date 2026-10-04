'use strict';
// Figuren-Verankerung (Figuren-Werkstatt, Ist-Index): findet die tatsächlichen
// Fundstellen der geplanten psychologischen Kerne (want/need/wound/lie/bogen/
// konflikt) im Buchtext und legt sie in draft_figure_occurrences ab (Full-
// Replace pro Draft + Kern). Rein rückwärtsgewandt — liest bestehende Inhalte,
// schreibt NIE in den Buchtext. Kein KI-Prompt/callAI: die Erkennung nutzt den
// bereits vorhandenen Embedding-Index, genau wie motif-scan und beat-anchor.
//
// Der Query-Bau ist die eine inhaltliche Entscheidung hier: gefragt wird nach
// dem KERN, nicht nach der Figur. Der Figurenname geht trotzdem mit hinein,
// damit die Hybrid-Fusion ihn wörtlich trägt und die Semantik nicht in die
// Wunden fremder Figuren läuft — aber er steht nicht allein, sonst käme jede
// Seite zurück, auf der die Figur vorkommt (das beantwortet figure_appearances).

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers,
  startBookJob, i18nError,
} = require('./shared');
const draftDb = require('../../db/draft-figures');
const occDb = require('../../db/draft-figure-occurrences');
const { extractPsychologie, PSYCHE_KERNE } = require('../../lib/draft-mindmap-extract');
const appSettings = require('../../lib/app-settings');
const embed = require('../../lib/embed');
const retrieval = require('../../lib/semantic-retrieval');
const { getSceneTitleForUser } = require('../../db/book-chat/figures');
const logger = require('../../logger');

const figurAnchorRouter = express.Router();

// Fund-Kinds im Text — genau die, die draft_figure_occurrences via CHECK erlaubt.
const SCAN_KINDS = ['page', 'scene'];
const TOP_K = 25;

const _TAG = /<\/?[^>]+>/g;
const _ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
function _plainSnippet(s) {
  return String(s || '').replace(_TAG, '').replace(/&(amp|lt|gt|quot|#39);/g, m => _ENT[m] || m).trim().slice(0, 400);
}

function _occKey(kind, entityId) { return `${kind}:${entityId}`; }
function _toOcc(kind, entityId, score, snippet, source) {
  const isPage = kind === 'page';
  return { kind, pageId: isPage ? entityId : null, sceneId: isPage ? null : entityId, score, snippet, source };
}

// Query eines Kerns: Figurenname + die vom Autor formulierten Kern-Zeilen.
// Mehrere Zeilen unter einem Container werden zu EINER Anfrage verbunden — sie
// beschreiben denselben Kern aus verschiedenen Winkeln, und getrennte Anfragen
// würden dieselben Stellen mehrfach zurückgeben.
function _kernQuery(draftName, zeilen) {
  const kernText = (zeilen || []).map(s => String(s || '').trim()).filter(Boolean).join('. ');
  if (!kernText) return '';
  return `${String(draftName || '').trim()}. ${kernText}`.trim();
}

// Fundstellen EINES Kerns sammeln. Dedup pro (kind, entity) — ein Ort zählt
// einmal je Kern (über Kerne hinweg darf dieselbe Seite mehrfach stehen: sie
// trägt dann Wunde UND Lüge, und genau das soll das Verlaufsband zeigen).
//
// Ohne Embedding-Backend läuft hier NICHTS: ein Kern ist eine Bedeutung
// („sie glaubt, nur ihre Leistung macht sie wertvoll"), keine Zeichenfolge —
// eine wörtliche Suche darüber liefert Zufallstreffer. Das ist der bewusste
// Unterschied zum Motiv-Scan, der wörtliche `trigger_terms` hat, und zum
// Beat-Anchor, dessen Titel wenigstens Eigennamen trägt.
//
// Konfidenz ist der ROHE COSINUS (`semScore`, 0–1), nicht `score`: bei Hybrid
// (Default `embed.hybrid`) ist `score` der RRF-Rang-Wert (max. ~0.03), mit Rerank
// die Rerank-Relevanz — beides nicht gegen die absolute Schwelle
// `werkstatt.anchor.min_score` (Default 0.35) vergleichbar; jeder Treffer fiele
// darunter. Reine FTS-Fusions-Kandidaten (semScore null) sind semantisch nicht
// belegt und werden übersprungen. Gespeichert wird semScore (Muster motif-scan,
// beat-anchor).
//
// `keep` (optional): Besitz-Filter. Szenen sind Analyse-Daten pro User, der
// Embedding-Index hängt aber nur am Buch — ohne Filter würden die Szenen eines
// Mitautors zu Fundstellen der eigenen Figur.
function _occsFromHits(hits, minScore, keep = null) {
  const found = new Map();
  for (const h of (hits || [])) {
    if (h.semScore == null) continue;
    if (keep && !keep(h)) continue;
    if (minScore > 0 && h.semScore < minScore) continue;
    const key = _occKey(h.kind, h.entity_id);
    if (found.has(key)) continue;
    found.set(key, _toOcc(h.kind, h.entity_id, h.semScore, _plainSnippet(h.text), 'semantic'));
  }
  return [...found.values()];
}

// Besitz-Prädikat für Treffer: Seiten gehören dem Buch, Szenen dem User, der sie
// analysiert hat (figure_scenes.user_email).
function _ownHit(userEmail) {
  return h => h.kind !== 'scene' || getSceneTitleForUser(h.entity_id, userEmail) != null;
}

async function _anchorKern(bookId, query, signalFn, minScore, userEmail) {
  if (!query) return [];
  const hits = await retrieval.semanticQuery(bookId, query, { kinds: SCAN_KINDS, topK: TOP_K, signal: signalFn() });
  return _occsFromHits(hits, minScore, _ownHit(userEmail));
}

async function runFigurAnchorJob(jobId, bookId, userEmail) {
  const log = makeJobLogger(jobId);
  try {
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    const throwIfAborted = () => {
      if (signal()?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    };

    if (!embed.isEnabled()) {
      // Kein stiller Teil-Erfolg: ohne Semantik gibt es zu dieser Frage keine
      // Antwort, und ein leerer Index wäre als „nichts im Buch" lesbar. Der Lauf
      // endet als Fehler, nicht als `done` — ein `done`-Lauf in job_runs zählt
      // für den Bogen als „verankert" (db/draft-figure-occurrences.js#figurAnchorState).
      throw i18nError('job.error.figurAnchorNoSemantic');
    }
    if (!retrieval.indexReady(bookId)) {
      // Backend da, aber noch kein vollständiger Index-Lauf unter dem aktiven
      // Modell (Erstindex läuft, Modellwechsel): die Suche fände nichts, und ein
      // Full-Replace mit [] behauptete „nichts im Buch". Bestehende Fundstellen
      // bleiben unangetastet. Bewusst Fehler statt `done` mit Skip-Flag: ein
      // `done`-Lauf in job_runs zählt als „verankert" (figurAnchorState), auch
      // wenn er nichts gesucht hat.
      throw i18nError('job.error.anchorNoIndex');
    }

    const floor = Number(appSettings.get('werkstatt.anchor.min_score')) || 0;
    const drafts = draftDb.listDraftFigures(bookId, userEmail);

    updateJob(jobId, {
      statusText: 'job.phase.figurAnchor',
      statusParams: { done: 0, total: drafts.length }, progress: 5,
    });

    let totalOcc = 0, scanned = 0;
    for (let i = 0; i < drafts.length; i++) {
      throwIfAborted();
      const draft = drafts[i];
      const psy = extractPsychologie(draft.mindmap);
      if (!psy) {
        // Kein ausgearbeiteter Kern → Index dieses Drafts räumen, sonst bliebe
        // ein Bogen stehen, den die Mindmap nicht mehr behauptet.
        occDb.clearDraftOccurrences(draft.id);
      } else {
        scanned++;
        for (const kern of PSYCHE_KERNE) {
          throwIfAborted();
          const rows = await _anchorKern(bookId, _kernQuery(draft.name, psy[kern]), signal, floor, userEmail);
          occDb.replaceKernOccurrences(draft.id, bookId, kern, rows);
          totalOcc += rows.length;
        }
      }
      updateJob(jobId, {
        statusText: 'job.phase.figurAnchor',
        statusParams: { done: i + 1, total: drafts.length },
        progress: 5 + Math.round(((i + 1) / Math.max(drafts.length, 1)) * 90),
      });
    }

    log.info(`Figur-Anchor ${bookId}: ${scanned}/${drafts.length} Drafts mit Kernen, ${totalOcc} Fundstellen.`);
    completeJob(jobId, { drafts: scanned, occurrences: totalOcc, semantic: true }, null,
      `${scanned} Figuren, ${totalOcc} Fundstellen`);
  } catch (e) {
    if (e.name !== 'AbortError') log.error(`Figur-Anchor Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

// Nacht-Cron: hält den Ist-Index aller Bücher/User frisch (nach dem embed-
// Reindex, wie motif-scan und beat-anchor). Ein Anchor pro (Buch, User) mit
// Drafts; Dedup gegen laufende Jobs.
const { db } = require('../../db/schema');
async function anchorAllDraftFigures() {
  if (!embed.isEnabled()) {
    logger.info('Figur-Anchor (Cron): uebersprungen (kein Embedding-Backend).');
    return { enqueued: 0, skipped: 0 };
  }
  const scopes = db.prepare('SELECT DISTINCT book_id, user_email FROM draft_figures').all();
  let enqueued = 0, skipped = 0;
  for (const { book_id, user_email } of scopes) {
    // Ohne fertigen Index würde der Lauf nur mit anchorNoIndex scheitern.
    if (!retrieval.indexReady(book_id)) { skipped++; continue; }
    if (findActiveJobId('figur-anchor', book_id, user_email)) { skipped++; continue; }
    const jobId = createJob('figur-anchor', book_id, user_email, 'job.label.figurAnchor', null, book_id);
    enqueueJob(jobId, () => runFigurAnchorJob(jobId, book_id, user_email));
    enqueued++;
  }
  logger.info(`Figur-Anchor (Cron): ${enqueued} Scope(s) eingereiht, ${skipped} uebersprungen (laeuft bereits).`);
  return { enqueued, skipped };
}

figurAnchorRouter.post('/figur-anchor', jsonBody, (req, res) => startBookJob(req, res, {
  type: 'figur-anchor',
  minRole: 'editor',
  label: 'job.label.figurAnchor',
  run: (jobId, { bookId, userEmail }) => runFigurAnchorJob(jobId, bookId, userEmail),
}));

module.exports = { figurAnchorRouter, runFigurAnchorJob, anchorAllDraftFigures, _occsFromHits, _ownHit };
