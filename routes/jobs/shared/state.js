'use strict';

// In-Memory-State der Job-Queue. Wird von queue/jobs/router/ai geteilt –
// in CJS sind die exportierten Map/Array-Referenzen identisch in allen Importern.
// key: jobId → { id, type, bookId, status, progress, statusText, result, error, … }
const jobs = new Map();
// key: `${type}:${bookId}:${userEmail}` → jobId  (verhindert Doppel-Starts)
const runningJobs = new Map();
// key: jobId → AbortController
const jobAbortControllers = new Map();
// FIFO-Warteschlange: { jobId, fn, interactive } — `interactive` wählt die Spur
// (queue.js#drainQueue).
const jobQueue = [];

// Kurze, interaktive Job-Typen, auf die ein User am Bildschirm wartet: sie
// bekommen die reservierten Slots (`jobs.interactive_slots`) und warten so nie
// hinter langen Analysen. Nur Typen mit EINEM (bzw. im agentischen Chat wenigen,
// gedeckelten) KI-Call — ein Typ, der stundenlang laufen kann, gehört nicht
// hierher, sonst blockiert er genau die Spur, die er freihalten soll.
const INTERACTIVE_JOB_TYPES = new Set([
  'chat', 'book-chat', 'research-chat', 'plot-chat', 'ideen-chat', // die fünf Chats
  'synonym',
]);
function isInteractiveJobType(type) {
  return INTERACTIVE_JOB_TYPES.has(type);
}

// Warteposition eines Jobs INNERHALB seiner Spur (1-basiert, 0 = nicht wartend).
// Die Spur ist das, worauf der Job wirklich wartet: ein Chat hinter drei
// Komplettanalysen ist trotzdem der nächste.
function queuePosition(jobId) {
  const idx = jobQueue.findIndex(e => e.jobId === jobId);
  if (idx === -1) return 0;
  const lane = !!jobQueue[idx].interactive;
  let pos = 0;
  for (let i = 0; i <= idx; i++) if (!!jobQueue[i].interactive === lane) pos++;
  return pos;
}

function jobKey(type, bookId, userEmail) {
  return `${type}:${bookId}:${userEmail || ''}`;
}

function jobDedupKey(job) {
  return jobKey(job.type, job.dedupId ?? job.bookId, job.userEmail);
}

module.exports = {
  jobs, runningJobs, jobAbortControllers, jobQueue,
  jobKey, jobDedupKey,
  INTERACTIVE_JOB_TYPES, isInteractiveJobType, queuePosition,
};
