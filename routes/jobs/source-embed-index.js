'use strict';
// Quellen-PDF Embedding-Index-Job (semantische Suche über die Quellen-PDFs des
// Users). Pendant zu routes/jobs/embed-index.js, aber **user-skopiert**: Quellen
// gehören dem User (`sources.owner_email`), keinem Buch, und die Vektoren
// liegen in `source_semantic_chunks` (vgl. db/source-semantic-chunks.js).
//
// Rein rückwärts­gewandt — liest `sources.doc_text`, schreibt NIE in den Buch-
// text. Kein AI-Prompt: der Embedding-Endpunkt (embed.*, self-hosted) liefert
// reine Vektoren. Delta-Cache: pro Chunk ein `content_hash`; unveränderte
// Chunks behalten ihren Vektor (kein erneuter Embedding-Call). `model` steht
// im Chunk-Key — ein Modellwechsel erzwingt vollständiges Neu-Embedden, alte
// Modell-Chunks räumt `clearForeignModels` am Ende jedes Laufs.
//
// Zwei Eingänge:
//   - enqueueSourceEmbedIndexJob(email)  → Trigger nach Upload (s. routes/sources.js)
//                                          und POST /jobs/source-embed-index
//   - reindexAllUserSources()            → Nacht-Cron: alle User mit Quellen-PDFs
//
// Der Job läuft IMMER über die ganze Bibliothek des Users, nie über eine
// einzelne Quelle — der Delta-Cache macht den Ein-PDF-Fall genauso billig, und
// eine zweite Skopierung wäre ein zweiter Pfad, der auseinanderdriften kann.

const express = require('express');
const { db } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers, jobs,
} = require('./shared');
const embed = require('../../lib/embed');
const { chunkText, contentHash } = require('../../lib/embed-chunk');
const sourceSemanticChunks = require('../../db/source-semantic-chunks');
const { markSourceIndexed, getSourceDocText, getSourceDocMeta } = require('../../db/schema');
const { setContext } = require('../../lib/log-context');
const logger = require('../../logger');
const { sessionEmail } = require('../../lib/acl');

const sourceEmbedIndexRouter = express.Router();

const JOB_TYPE = 'source-embed-index';
const JOB_LABEL = 'job.label.sourceEmbedIndex';
// Dedup-Id ist die userEmail — die Indexierung ist pro User. Statt pro Upload
// einen separaten Job zu erzeugen, wird ein laufender User-Job reused und ein
// einziger Folgelauf vorgemerkt (sonst würde Mehrfach-Hochladen den Worker
// überfluten).
function _dedupKey(userEmail) { return `user:${userEmail}`; }

// IDs der Quellen des Users mit PDF-Volltext. Bewusst nur die IDs: der
// Volltext (bis 200k Zeichen je Quelle) wird pro Quelle nachgeladen und nach
// dem Chunken wieder fallengelassen, statt die ganze Bibliothek gleichzeitig
// im Job-Speicher zu halten.
function _candidateIds(userEmail) {
  return sourceSemanticChunks.listIndexedCandidates(userEmail).map(r => r.id);
}

async function runSourceEmbedIndexJob(jobId, userEmail) {
  const l = makeJobLogger(jobId);
  try {
    if (!embed.isEnabled()) throw i18nError('job.error.embedDisabled');
    const { model, dim, passagePrefix } = embed.getConfig();
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    const throwIfAborted = () => {
      if (signal()?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    };

    updateJob(jobId, { statusText: 'job.phase.sourceEmbedCollect', progress: 5 });

    const rowsBySource = new Map();
    // Dokument-Stand je Quelle beim Sammeln. Wird das PDF während des Laufs
    // ersetzt oder entfernt, gehören die gerechneten Vektoren zum alten Stand:
    // dann nicht schreiben (und nicht „indiziert" stempeln), sondern einen
    // Folgelauf anfordern.
    const docHashAtCollect = new Map();
    const pending = [];
    const presentIds = [];
    let totalChunks = 0;

    for (const sourceId of _candidateIds(userEmail)) {
      throwIfAborted();
      presentIds.push(sourceId);
      docHashAtCollect.set(sourceId, getSourceDocMeta(sourceId)?.doc_content_hash ?? null);
      // Volltext nur fuer die Dauer des Chunkens im Speicher.
      const chunks = chunkText(getSourceDocText(sourceId));
      if (!chunks.length) continue;
      rowsBySource.set(sourceId, []);
      const existing = sourceSemanticChunks.getSourceChunks(sourceId, model);
      chunks.forEach((text, ix) => {
        totalChunks++;
        const embedInput = passagePrefix ? passagePrefix + text : text;
        const hash = contentHash(embedInput);
        const prev = existing.get(ix);
        if (prev && prev.content_hash === hash && prev.vector.length === dim) {
          rowsBySource.get(sourceId).push({ chunk_ix: ix, content_hash: hash, vector: prev.vector, text });
        } else {
          pending.push({ sourceId, ix, text, embedInput, hash });
        }
      });
    }

    l.info(`Source-Index ${userEmail}: ${totalChunks} Chunks, davon ${pending.length} neu (${totalChunks - pending.length} aus Cache).`);
    updateJob(jobId, { statusText: 'job.phase.sourceEmbedding', statusParams: { done: 0, total: pending.length }, progress: 15 });

    const pendingBySource = new Map();
    for (const p of pending) {
      pendingBySource.set(p.sourceId, (pendingBySource.get(p.sourceId) || 0) + 1);
    }
    let changedDuringRun = 0;
    const persistSource = (sourceId) => {
      const rows = rowsBySource.get(sourceId);
      const meta = getSourceDocMeta(sourceId);
      if (!meta || (meta.doc_content_hash ?? null) !== docHashAtCollect.get(sourceId)) {
        rowsBySource.delete(sourceId);
        changedDuringRun++;
        _rerunRequested.add(userEmail);
        return;
      }
      rows.sort((a, b) => a.chunk_ix - b.chunk_ix);
      sourceSemanticChunks.replaceSource(sourceId, userEmail, model, dim, rows);
      // Index-Stand verzeichnen (fürs Stale-Heuristic in der Karte). updated_at
      // darf dadurch nicht springen — der Trigger nur `doc_indexed_at`.
      markSourceIndexed(sourceId, new Date().toISOString());
      rowsBySource.delete(sourceId);
    };

    const BATCH = 64;
    for (let i = 0; i < pending.length; i += BATCH) {
      throwIfAborted();
      const slice = pending.slice(i, i + BATCH);
      const vecs = await embed.embedBatch(slice.map(p => p.embedInput), { signal: signal() });
      const touched = new Set();
      slice.forEach((p, j) => {
        rowsBySource.get(p.sourceId).push({ chunk_ix: p.ix, content_hash: p.hash, vector: vecs[j], text: p.text });
        pendingBySource.set(p.sourceId, pendingBySource.get(p.sourceId) - 1);
        touched.add(p.sourceId);
      });
      for (const sid of touched) {
        if (pendingBySource.get(sid) === 0) { persistSource(sid); pendingBySource.delete(sid); }
      }
      const done = Math.min(i + BATCH, pending.length);
      updateJob(jobId, {
        statusText: 'job.phase.sourceEmbedding', statusParams: { done, total: pending.length },
        progress: 15 + Math.round((done / Math.max(pending.length, 1)) * 75),
      });
    }

    for (const sid of [...rowsBySource.keys()]) persistSource(sid);
    if (changedDuringRun) l.info(`${changedDuringRun} Quelle(n) während des Laufs geändert — Folgelauf angefordert.`);
    // Eine während des Laufs hochgeladene PDF steht nicht in presentIds — ihr
    // Folgelauf indiziert sie. pruneMissing prüft darum gegen den aktuellen
    // Kandidatenstand, damit es nichts löscht, was inzwischen dazukam.
    const pruned = sourceSemanticChunks.pruneMissing(userEmail, model, _candidateIds(userEmail));
    // Chunks unter einem frueher aktiven Modell raeumen. `pruneMissing` ist
    // modell-skopiert und sieht sie per Definition nie — ohne diesen Schritt
    // waechst die Tabelle bei jedem Modellwechsel monoton weiter.
    const dropped = sourceSemanticChunks.clearForeignModels(userEmail, model);
    if (dropped) l.info(`Fremdmodell-Chunks entfernt: ${dropped} (aktives Modell ${model}).`);

    updateJob(jobId, { progress: 98 });
    const stats = sourceSemanticChunks.indexStatus(userEmail, model);
    completeJob(jobId, {
      model, dim, totalChunks: stats.total, embedded: pending.length,
      reused: totalChunks - pending.length, pruned, droppedForeignModel: dropped,
      indexedSources: presentIds.length,
    }, null, `${stats.total} Chunks (${pending.length} neu, ${totalChunks - pending.length} aus Cache${pruned ? `, ${pruned} verwaist entfernt` : ''}) bei ${presentIds.length} Quellen`);
  } catch (e) {
    if (e.name !== 'AbortError') l.error(`Quellen-Embedding-Index Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  } finally {
    if (_rerunRequested.delete(userEmail)) _enqueue(userEmail);
  }
}

// User, für die während eines laufenden Laufs ein weiterer angefordert wurde
// (Upload/Löschen eines PDFs mitten im Lauf). Der laufende hat seine Quellen am
// Anfang gesammelt — nach seinem Ende startet genau ein Folgelauf.
const _rerunRequested = new Set();

function _enqueue(userEmail) {
  const jobId = createJob(JOB_TYPE, null, userEmail, JOB_LABEL, null, _dedupKey(userEmail));
  enqueueJob(jobId, () => runSourceEmbedIndexJob(jobId, userEmail));
  return jobId;
}

// Nacht-Cron-Pendant: reindex pro User, der PDFs hat (Dedup gegen laufende Jobs).
// Billig für indizierte User (Delta-Cache), Erst-Index für frisch hochgeladene.
async function reindexAllUserSources() {
  if (!embed.isEnabled()) return { enqueued: 0, skipped: 0, disabled: true };
  const users = db.prepare(
    `SELECT DISTINCT owner_email FROM sources
      WHERE doc_text IS NOT NULL AND doc_text <> ''`
  ).all();
  let enqueued = 0, skipped = 0;
  for (const { owner_email: userEmail } of users) {
    if (findActiveJobId(JOB_TYPE, _dedupKey(userEmail), userEmail)) { skipped++; continue; }
    const jobId = createJob(JOB_TYPE, null, userEmail, JOB_LABEL, null, _dedupKey(userEmail));
    enqueueJob(jobId, () => runSourceEmbedIndexJob(jobId, userEmail));
    enqueued++;
  }
  logger.info(`Quellen-Embedding-Reindex (Cron): ${enqueued} User eingereiht, ${skipped} übersprungen (Job läuft bereits).`);
  return { enqueued, skipped };
}

// Trigger nach Upload: erzeugt den Job (dedup gegen laufende User-Jobs).
// Läuft schon einer, sieht er die neue PDF nicht mehr — dann wird ein Folgelauf
// vorgemerkt. Der Aufrufer bekommt die Id des laufenden und kann sie pollen.
function enqueueSourceEmbedIndexJob(userEmail) {
  if (!embed.isEnabled()) return null;
  const existing = findActiveJobId(JOB_TYPE, _dedupKey(userEmail), userEmail);
  if (existing) {
    if (jobs.get(existing)?.status === 'running') _rerunRequested.add(userEmail);
    return existing;
  }
  return _enqueue(userEmail);
}

sourceEmbedIndexRouter.post('/source-embed-index', jsonBody, (req, res) => {
  const userEmail = sessionEmail(req);
  if (!userEmail) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  setContext({ user: userEmail });
  if (!embed.isEnabled()) return res.status(400).json({ error_code: 'EMBED_DISABLED' });
  const existing = findActiveJobId(JOB_TYPE, _dedupKey(userEmail), userEmail);
  const jobId = enqueueSourceEmbedIndexJob(userEmail);
  res.json(existing ? { jobId, existing: true } : { jobId });
});

module.exports = {
  sourceEmbedIndexRouter, runSourceEmbedIndexJob, reindexAllUserSources,
  enqueueSourceEmbedIndexJob, JOB_TYPE,
};