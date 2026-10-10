'use strict';
// Embedding-Index des Chat-Verlaufs (Bedeutungs-Hälfte der Verlaufssuche,
// docs/chats.md#suche-im-verlauf). Pendant zu routes/jobs/source-embed-index.js,
// aber pro BUCH: vektorisiert jede Gesprächs-Runde (Frage + Antwort) der
// Abschnitts- und Buch-Chats aller User dieses Buchs, die unter dem aktiven
// Modell noch keinen Vektor hat. Schreibt nur `chat_semantic_chunks`.
//
// Kein Delta-Cache über Hashes nötig: Chat-Nachrichten werden nie umgeschrieben,
// eine Runde ist entweder vektorisiert oder nicht. Ein Modellwechsel macht jede
// Runde wieder „offen"; die alten Vektoren räumt clearForeignModels am Ende.
//
// Eingänge:
//   - enqueueChatEmbedIndexJob(bookId) → die Verlaufssuche (GET /chat/search),
//     sobald sie offene Runden sieht, und POST /jobs/chat-embed-index
//   - reindexAllChats()                → Nacht-Cron, nur Bücher mit offenen Runden
// Neue Antworten werden darum nicht sofort vektorisiert: bis zum nächsten Lauf
// findet die Suche sie über den Wortlaut (FTS-Trigger, sofort).

const express = require('express');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  createJob, enqueueJob, findActiveJobId, jsonBody, jobAbortControllers, jobs,
} = require('./shared');
const embed = require('../../lib/embed');
const { chunkText, contentHash } = require('../../lib/embed-chunk');
const chatSearchDb = require('../../db/chat-search');
const { toIntId } = require('../../lib/validate');
const { guardBook, sessionEmail } = require('../../lib/acl');
const { setContext } = require('../../lib/log-context');
const logger = require('../../logger');

const chatEmbedIndexRouter = express.Router();

const JOB_TYPE = 'chat-embed-index';
const JOB_LABEL = 'job.label.chatEmbedIndex';
const PAGE = 200;   // Runden pro DB-Seite
const BATCH = 64;   // Chunks pro Embedding-Aufruf

// Text einer Runde fürs Embedding: Frage und Antwort als zwei Absätze.
function roundText(question, answer) {
  const q = String(question || '').trim();
  const a = String(answer || '').trim();
  return q ? `${q}\n\n${a}` : a;
}

async function runChatEmbedIndexJob(jobId, bookId) {
  const l = makeJobLogger(jobId);
  try {
    if (!embed.isEnabled()) throw i18nError('job.error.embedDisabled');
    const { model, dim, passagePrefix } = embed.getConfig();
    const signal = () => jobAbortControllers.get(jobId)?.signal;
    const throwIfAborted = () => {
      if (signal()?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    };

    const total = chatSearchDb.countUnindexedRounds(bookId, model);
    l.info(`Chat-Index Buch ${bookId}: ${total} Runde(n) offen (Modell ${model}).`);
    updateJob(jobId, { statusText: 'job.phase.chatEmbedding', statusParams: { done: 0, total }, progress: 5 });

    let afterId = 0, done = 0, chunksWritten = 0, vanished = 0;
    for (;;) {
      throwIfAborted();
      const rounds = chatSearchDb.listUnindexedRounds(bookId, model, { afterId, limit: PAGE });
      if (!rounds.length) break;
      afterId = rounds[rounds.length - 1].id;

      // Chunks der ganzen Seite sammeln, in Batches embedden, je Runde schreiben.
      const pending = [];
      const rowsByMsg = new Map();
      for (const r of rounds) {
        const chunks = chunkText(roundText(r.question, r.content));
        rowsByMsg.set(r.id, { left: chunks.length, rows: [] });
        chunks.forEach((text, ix) => {
          const embedInput = passagePrefix ? passagePrefix + text : text;
          pending.push({ msgId: r.id, ix, text, embedInput, hash: contentHash(embedInput) });
        });
      }
      const persist = (msgId) => {
        const e = rowsByMsg.get(msgId);
        e.rows.sort((a, b) => a.chunk_ix - b.chunk_ix);
        if (chatSearchDb.replaceRoundChunks(msgId, model, dim, e.rows)) chunksWritten += e.rows.length;
        else vanished++;
        rowsByMsg.delete(msgId);
        done++;
      };
      for (let i = 0; i < pending.length; i += BATCH) {
        throwIfAborted();
        const slice = pending.slice(i, i + BATCH);
        const vecs = await embed.embedBatch(slice.map(p => p.embedInput), { signal: signal() });
        slice.forEach((p, j) => {
          if (vecs[j].length !== dim) throw i18nError('job.error.embedDimMismatch', { expected: dim, actual: vecs[j].length });
          const e = rowsByMsg.get(p.msgId);
          e.rows.push({ chunk_ix: p.ix, content_hash: p.hash, vector: vecs[j], text: p.text });
          if (--e.left === 0) persist(p.msgId);
        });
        updateJob(jobId, {
          statusText: 'job.phase.chatEmbedding', statusParams: { done, total },
          progress: 5 + Math.round((Math.min(done, total) / Math.max(total, 1)) * 90),
        });
      }
    }

    const dropped = chatSearchDb.clearForeignModels(bookId, model);
    if (dropped) l.info(`Fremdmodell-Chunks entfernt: ${dropped} (aktives Modell ${model}).`);
    completeJob(jobId, { model, dim, rounds: done, chunks: chunksWritten, vanished, droppedForeignModel: dropped },
      null, `${done} Runde(n), ${chunksWritten} Chunks${vanished ? `, ${vanished} während des Laufs gelöscht` : ''}`);
  } catch (e) {
    if (e.name !== 'AbortError') l.error(`Chat-Embedding-Index Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

function _enqueue(bookId) {
  const jobId = createJob(JOB_TYPE, bookId, null, JOB_LABEL, null, bookId);
  enqueueJob(jobId, () => runChatEmbedIndexJob(jobId, bookId));
  return jobId;
}

// Lauf für ein Buch anfordern; ein schon laufender/wartender wird wiederverwendet.
// Was er nicht mehr sieht (Antwort kam nach seiner letzten DB-Seite), holt der
// nächste Anstoss nach — die Suche fordert ihn an, solange Runden offen sind.
function enqueueChatEmbedIndexJob(bookId) {
  if (!embed.isEnabled()) return null;
  return findActiveJobId(JOB_TYPE, bookId, null) || _enqueue(bookId);
}

// Nacht-Cron: nur Bücher mit offenen Runden — ein vollständig indizierter Verlauf
// kostet keinen Job.
async function reindexAllChats() {
  if (!embed.isEnabled()) return { enqueued: 0, disabled: true };
  const { model } = embed.getConfig();
  let enqueued = 0;
  for (const bookId of chatSearchDb.booksWithUnindexedRounds(model)) {
    if (findActiveJobId(JOB_TYPE, bookId, null)) continue;
    _enqueue(bookId);
    enqueued++;
  }
  logger.info(`Chat-Embedding-Index (Cron): ${enqueued} Buch/Bücher eingereiht.`);
  return { enqueued };
}

chatEmbedIndexRouter.post('/chat-embed-index', jsonBody, (req, res) => {
  const bookId = toIntId(req.body?.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  setContext({ book: bookId });
  if (!guardBook(req, res, bookId, 'viewer')) return;
  if (!embed.isEnabled()) return res.status(400).json({ error_code: 'EMBED_DISABLED' });
  logger.info(`Chat-Index angefordert von ${sessionEmail(req)} (Buch ${bookId}).`);
  const existing = findActiveJobId(JOB_TYPE, bookId, null);
  const jobId = enqueueChatEmbedIndexJob(bookId);
  res.json(existing ? { jobId, existing: true } : { jobId });
});

module.exports = {
  chatEmbedIndexRouter, runChatEmbedIndexJob, enqueueChatEmbedIndexJob, reindexAllChats, roundText,
};
