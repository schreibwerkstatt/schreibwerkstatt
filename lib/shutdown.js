'use strict';
// Graceful Shutdown: SIGTERM/SIGINT (systemd-Stopp, jeder Deploy), gewollte
// Neustarts (Admin-Restore) und uncaughtException laufen hier durch.
//
// Ablauf ab Stopp-Anforderung (t = 0):
//   1. Gate zu: neue Requests auf noch offenen Keep-Alive-Verbindungen bekommen
//      `503 SHUTTING_DOWN` + `Connection: close`; die Job-Queue startet nichts
//      mehr (Wartende sterben mit dem Prozess, cleanupStuckJobRuns räumt beim
//      Boot ihre job_runs auf — die Queue lebt nur im Speicher, ein Wieder-
//      Einreihen gibt es nicht).
//   2. server.close(); SSE-/Streaming-Antworten werden aktiv beendet —
//      EventSource verbindet sich selbst neu (public/js/event-stream.js).
//      closeIdleConnections() läuft während des ganzen Drains im Takt: jede
//      fertige Antwort hinterlässt sonst eine Keep-Alive-Verbindung.
//   3. Laufende Jobs dürfen bis JOB_GRACE_MS fertig werden, danach Abbruch über
//      ihren AbortController (wie ein User-Abbruch → failJob 'cancelled',
//      job_runs abgeschlossen). better-sqlite3 schreibt synchron: ein Abbruch
//      greift nur an einem await, nie mitten in einem Statement/einer Transaktion.
//   4. Bis CONN_DEADLINE_MS auf die letzten HTTP-Antworten warten, dann
//      closeAllConnections() und WARN mit der Liste, was noch offen war.
//   5. WAL-Checkpoint + db.close(), Exit.
//
// Exit-Code: ein angeforderter Stopp endet mit 0, auch wenn eine Frist greift —
// Restart=always startet trotzdem neu, `systemctl stop` bleibt gestoppt. Exit 1
// nur, wenn der Shutdown selbst scheitert (DB lässt sich nicht schliessen) oder
// der Auslöser ein echter Fehler war (uncaughtException).

const logger = require('../logger');

// HARD_TIMEOUT_MS muss unter TimeoutStopSec der Units (deploy/*.service) bleiben.
const TIMINGS = Object.freeze({
  JOB_GRACE_MS: 15_000,
  ABORT_SETTLE_MS: 3_000,
  CONN_DEADLINE_MS: 25_000,
  HARD_TIMEOUT_MS: 30_000,
});
const POLL_MS = 100;
let T = TIMINGS;

const streams = new Set();
const connections = new Set();
let shuttingDown = false;
let deps = null;

/** SSE-/Streaming-Antwort anmelden: sie wird beim Shutdown aktiv beendet,
 *  statt server.close() bis zum Timeout offen zu halten. */
function trackStream(res) {
  streams.add(res);
  res.on('close', () => streams.delete(res));
}

function isShuttingDown() { return shuttingDown; }

// Ganz vorne in der Middleware-Kette: was nach Stopp-Anforderung noch über eine
// offene Verbindung kommt, wird nicht mehr bearbeitet (startet weder Job noch
// Schreibvorgang). Der Client behandelt 503 wie einen Netzfehler.
function gate(_req, res, next) {
  if (!shuttingDown) return next();
  res.setHeader('Connection', 'close');
  res.setHeader('Retry-After', '5');
  res.status(503).json({ error_code: 'SHUTTING_DOWN' });
}

function _jobsApi() {
  const { jobs, jobQueue, jobAbortControllers } = require('../routes/jobs/shared/state');
  return { jobs, jobQueue, jobAbortControllers };
}

function _runningJobs() {
  const { jobs } = _jobsApi();
  return [...jobs.values()].filter(j => j.status === 'running');
}

/** Momentaufnahme dessen, was den Prozess noch offen hält — für das WARN beim
 *  Erreichen einer Frist und für Tests. */
function openHandles() {
  const { jobQueue } = _jobsApi();
  const resources = {};
  for (const r of process.getActiveResourcesInfo()) resources[r] = (resources[r] || 0) + 1;
  return {
    httpConnections: connections.size,
    streams: streams.size,
    runningJobs: _runningJobs().map(j => `${j.type}#${j.id}`),
    queuedJobs: jobQueue.length,
    timers: resources.Timeout || 0,
    resources,
  };
}

function _fmtHandles(h) {
  const res = Object.entries(h.resources).map(([k, v]) => `${k}=${v}`).join(', ');
  return `HTTP-Verbindungen=${h.httpConnections}, SSE/Streams=${h.streams}, `
    + `laufende Jobs=[${h.runningJobs.join(', ') || '-'}], wartende Jobs=${h.queuedJobs}, `
    + `Timer=${h.timers} (${res || '-'})`;
}

// Bewusst NICHT unref: ist der Server zu, hält sonst nichts mehr die Event-Loop,
// und Node endete still mit 0 — vor Job-Abbruch und DB-Close.
const _sleep = ms => new Promise(r => { setTimeout(r, Math.max(0, ms)); });

async function _waitFor(pred, ms) {
  const until = Date.now() + ms;
  while (!pred() && Date.now() < until) await _sleep(POLL_MS);
  return pred();
}

function _abortRunningJobs() {
  const { jobAbortControllers } = _jobsApi();
  for (const job of _runningJobs()) {
    job.cancelled = true;
    jobAbortControllers.get(job.id)?.abort();
  }
}

function _closeDb(db) {
  try {
    try { db.pragma('optimize'); } catch { /* optional */ }
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    return true;
  } catch (e) {
    logger.error(`Shutdown: DB lässt sich nicht sauber schliessen: ${e.message}`);
    return false;
  }
}

async function _drain(t0) {
  const { server, db, stopQueue } = deps;
  stopQueue();
  const httpClosed = new Promise(resolve => server.close(() => resolve(true)));
  for (const res of [...streams]) { try { res.end(); } catch { /* peer weg */ } }
  // Nicht nur einmal: jede Antwort, die während des Drains fertig wird (auch
  // die eben beendeten Streams), lässt eine Keep-Alive-Verbindung zurück, die
  // server.close() sonst bis zur Frist offen hält.
  server.closeIdleConnections();
  const idleSweep = setInterval(() => server.closeIdleConnections(), POLL_MS);
  idleSweep.unref();

  if (!await _waitFor(() => _runningJobs().length === 0, T.JOB_GRACE_MS)) {
    logger.warn(`Shutdown: Jobs nach ${T.JOB_GRACE_MS / 1000} s nicht fertig – breche ab: `
      + _runningJobs().map(j => `${j.type}#${j.id}`).join(', '));
    _abortRunningJobs();
    await _waitFor(() => _runningJobs().length === 0, T.ABORT_SETTLE_MS);
  }

  const closed = await Promise.race([httpClosed, _sleep(T.CONN_DEADLINE_MS - (Date.now() - t0)).then(() => false)]);
  clearInterval(idleSweep);
  if (!closed) {
    logger.warn(`Drain-Timeout erreicht – schliesse offene Verbindungen. Offen: ${_fmtHandles(openHandles())}`);
    server.closeAllConnections();
  }
  return _closeDb(db);
}

/** Stopp anfordern. `exitCode` 0 = gewollt (Signal, Admin-Restore), 1 = Fehler
 *  als Auslöser. Mehrfachaufrufe sind wirkungslos. */
function requestShutdown(reason, { exitCode = 0 } = {}) {
  if (shuttingDown || !deps) return;
  shuttingDown = true;
  const t0 = Date.now();
  if (reason === 'SIGTERM' || reason === 'SIGINT') {
    // Wortlaut fix — das Monitoring zählt diese Zeile.
    logger.info(`${reason} empfangen – Graceful Shutdown (max 30 s Drain)…`);
  } else {
    logger.info(`${reason} – Graceful Shutdown (max 30 s Drain)…`);
  }
  const exit = deps.exit;
  const hard = setTimeout(() => {
    logger.warn(`Drain-Timeout erreicht – erzwinge Exit. Offen: ${_fmtHandles(openHandles())}`);
    const ok = _closeDb(deps.db);
    exit(ok ? exitCode : 1);
  }, T.HARD_TIMEOUT_MS);
  hard.unref();
  _drain(t0)
    .then(ok => {
      clearTimeout(hard);
      logger.info(`Graceful Shutdown abgeschlossen (${((Date.now() - t0) / 1000).toFixed(1)} s).`);
      exit(ok ? exitCode : 1);
    })
    .catch(e => {
      clearTimeout(hard);
      logger.error(`Shutdown fehlgeschlagen: ${e.message}`, { stack: e.stack });
      _closeDb(deps.db);
      exit(1);
    });
}

/** Einmal beim Boot: Server + DB bekannt machen, Signale abonnieren.
 *  `timings` nur für Tests (kürzere Fristen). */
function install({ server, db, exit = code => process.exit(code), timings = null }) {
  T = { ...TIMINGS, ...timings };
  deps = { server, db, exit, stopQueue: require('../routes/jobs/shared/queue').stopQueue };
  server.on('connection', sock => {
    connections.add(sock);
    sock.on('close', () => connections.delete(sock));
  });
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));
  process.on('SIGINT', () => requestShutdown('SIGINT'));
}

module.exports = {
  TIMINGS, install, gate, trackStream, requestShutdown, isShuttingDown, openHandles,
};
