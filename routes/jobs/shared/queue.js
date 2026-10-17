'use strict';
const logger = require('../../../logger');
const { runWithContext } = require('../../../lib/log-context');
const { startJobRun } = require('../../../db/schema');
const appSettings = require('../../../lib/app-settings');
const { jobs, runningJobs, jobQueue, jobDedupKey, isInteractiveJobType } = require('./state');
const { emitJobChange, emitQueueShift } = require('./events');

// Zwei Spuren in EINER FIFO (`jobQueue`, Eintrag trägt `interactive`):
//   - Allgemeine Slots (`jobs.max_concurrent`, Default 1): jeder Job-Typ, FIFO.
//   - Reservierte Slots (`jobs.interactive_slots`, Default 2): nur kurze,
//     interaktive Jobs (INTERACTIVE_JOB_TYPES in state.js — die fünf Chats,
//     Synonyme). Ein interaktiver Job nimmt zuerst einen reservierten Slot, dann
//     einen allgemeinen; ein schwerer Job nur einen allgemeinen.
// Damit wartet ein Chat-Turn nie hinter einer stundenlangen Komplettanalyse. FIFO
// bleibt innerhalb jeder Spur erhalten: der Scan läuft in Einreihungs-Reihenfolge,
// und ein Job überholt nur Einträge, die selbst gerade keinen Slot bekommen können.
function _maxConcurrent() {
  return parseInt(appSettings.get('jobs.max_concurrent'), 10) || 1;
}
function _interactiveSlots() {
  const n = parseInt(appSettings.get('jobs.interactive_slots'), 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}
let activeShared = 0;
let activeReserved = 0;

// Auto-Cleanup: 2 h nachdem der Job terminal (done|error|cancelled) wurde,
// wird der Memory-Eintrag entfernt. Vorher nicht – solange der Job läuft, soll
// der Client ihn abfragen können.
const CLEANUP_DELAY_MS = 2 * 60 * 60 * 1000;

// Welcher Slot-Topf nimmt diesen Eintrag jetzt auf? null = keiner frei.
function _pickSlot(entry, maxShared, reserved) {
  if (entry.interactive && activeReserved < reserved) return 'reserved';
  if (activeShared < maxShared) return 'shared';
  return null;
}

function drainQueue() {
  const maxShared = _maxConcurrent();
  const reserved = _interactiveSlots();
  let i = 0;
  while (i < jobQueue.length) {
    // Alles belegt → kein Eintrag kann starten, Scan sparen.
    if (activeShared >= maxShared && activeReserved >= reserved) break;
    const entry = jobQueue[i];
    const job = jobs.get(entry.jobId);
    if (!job) { jobQueue.splice(i, 1); continue; } // Job wurde zwischenzeitlich entfernt
    const slot = _pickSlot(entry, maxShared, reserved);
    if (!slot) { i++; continue; }
    jobQueue.splice(i, 1);
    _startJob(entry, job, slot);
  }
}

function _startJob({ jobId, fn }, job, slot) {
  if (slot === 'reserved') activeReserved++; else activeShared++;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  emitJobChange(job);
  emitQueueShift();
  const ctx = { job: job.type, user: job.userEmail || null, book: job.bookId, jobId };
  runWithContext(ctx, () => {
    try { startJobRun(jobId); } catch (e) { logger.error(`startJobRun: ${e.message}`); }
    // Job-Module loggen Start mit eigenem Detail (Pages-Count, Buchname etc.).
    // jobId steht via ALS-Ctx im Tag — kein zentrales Generik-Start nötig.
    // Promise.resolve().then(fn): auch ein synchroner Throw landet im catch,
    // sonst bliebe der Slot-Zähler fuer immer erhoeht. Ein Fehler, der am try des
    // Job-Moduls vorbeigeht (z.B. `await getPrompts()` davor), wird hier
    // terminal verbucht — ohne failJob bliebe der Job ewig auf 'running' und
    // der Dedup-Slot belegt.
    Promise.resolve().then(fn)
      .catch(e => {
        logger.error(`Unkontrollierter Job-Fehler: ${e?.message || e}`);
        const j = jobs.get(jobId);
        if (j && (j.status === 'queued' || j.status === 'running')) {
          try { require('./jobs').failJob(jobId, e instanceof Error ? e : new Error(String(e))); }
          catch (fe) { logger.error(`failJob nach unkontrolliertem Job-Fehler: ${fe.message}`); }
        }
      })
      .finally(() => {
        if (slot === 'reserved') activeReserved--; else activeShared--;
        drainQueue();
      });
  });
}

function enqueueJob(jobId, fn) {
  const job = jobs.get(jobId);
  jobQueue.push({ jobId, fn, interactive: isInteractiveJobType(job?.type) });
  emitJobChange(jobs.get(jobId));
  drainQueue();
}

function _scheduleJobCleanup(id) {
  const job = jobs.get(id);
  if (!job) return;
  const key = jobDedupKey(job);
  const timer = setTimeout(() => {
    jobs.delete(id);
    if (runningJobs.get(key) === id) runningJobs.delete(key);
  }, CLEANUP_DELAY_MS);
  timer.unref?.();
}

// Test-/Diagnose-Sicht auf die Slot-Belegung.
function _slotUsage() {
  return { shared: activeShared, reserved: activeReserved };
}

module.exports = {
  CLEANUP_DELAY_MS,
  drainQueue, enqueueJob, _scheduleJobCleanup, _slotUsage,
};
