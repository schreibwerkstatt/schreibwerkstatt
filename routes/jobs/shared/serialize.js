'use strict';
const { jobs, queuePosition } = require('./state');

// Client-Sicht eines Jobs — gemeinsame Form für `GET /jobs/:id`, `GET /jobs/queue`
// und den SSE-Stream (`GET /jobs/stream`). Ein Ort, damit Poll- und Push-Pfad
// dem Frontend nie unterschiedliche Felder liefern.

// Ein wartender Job zeigt seine Position in der FIFO seiner Spur (interaktiv vs.
// allgemein, queue.js) statt des gespeicherten statusText — die Position ändert
// sich, ohne dass der Job selbst angefasst wird.
function _liveStatus(job) {
  if (job.status !== 'queued') return { statusText: job.statusText, statusParams: job.statusParams };
  const pos = queuePosition(job.id);
  return pos > 0
    ? { statusText: 'job.queuedPos', statusParams: { pos } }
    : { statusText: 'job.queued', statusParams: null };
}

// `withResult: false` für den Stream: das Ergebnis kann gross sein (Komplettanalyse,
// Buch-Chat) und wird nur beim Terminal-Status gebraucht — das holt der Client dann
// einmal über `GET /jobs/:id`.
function jobView(job, { withResult = true } = {}) {
  const view = {
    id: job.id, type: job.type, status: job.status,
    bookId: job.bookId, dedupId: job.dedupId,
    progress: job.progress, ..._liveStatus(job),
    label: job.label, labelParams: job.labelParams,
    tokensIn: job.tokensIn, tokensOut: job.tokensOut,
    // tokensIn ist cache-inklusiv (lib/ai/claude.js) und im agentischen Tool-Loop
    // über alle Provider-Calls aufsummiert — ohne den Cache-Anteil ist die Zahl
    // im Live-Status nicht einzuordnen.
    cacheReadIn: job.cacheReadIn || 0,
    maxTokensOut: job.maxTokensOut,
    tokensPerSec: job.tokensPerSec,
    error: job.error, errorParams: job.errorParams,
    passMode: job.passMode ?? null,
  };
  if (withResult) view.result = job.result;
  return view;
}

// Aktive (queued/running) Jobs eines Users — Footer-Liste.
function queueItems(userEmail) {
  const result = [];
  for (const [, job] of jobs) {
    if (job.userEmail !== userEmail) continue;
    if (job.status !== 'queued' && job.status !== 'running') continue;
    result.push({
      id: job.id,
      type: job.type,
      bookId: job.bookId,
      dedupId: job.dedupId,
      label: job.label || job.type,
      labelParams: job.labelParams || null,
      status: job.status,
      progress: job.progress,
      ..._liveStatus(job),
      tokensIn: job.tokensIn || 0,
      tokensOut: job.tokensOut || 0,
      maxTokensOut: job.maxTokensOut || 0,
      tokensPerSec: job.tokensPerSec || 0,
      canCancel: true,
    });
  }
  return result;
}

function hasQueuedJob(userEmail) {
  for (const [, job] of jobs) {
    if (job.userEmail === userEmail && job.status === 'queued') return true;
  }
  return false;
}

module.exports = { jobView, queueItems, hasQueuedJob };
