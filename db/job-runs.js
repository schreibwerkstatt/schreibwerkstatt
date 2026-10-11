'use strict';
// Job-Laufzeiten (`job_runs`): eine Zeile pro Job mit Queue-/Start-/Endzeit,
// Token-Verbrauch und Fehlergrund. Quelle der Job-Statistiken und der
// /metrics-Kennzahlen.

const { db } = require('./connection');
// Prepared Statements dieses Moduls sitzen auf migrierten Spalten — die
// Migrationen muessen vor dem Anlegen gelaufen sein.
require('./migrations');
// Kosten-Ledger: endJobRun bucht den Lauf zusaetzlich dort ein (Kosten pro
// Job/Call-Klasse), damit Abrechnung und Job-Historie nicht auseinanderlaufen.
const { recordJobLedger } = require('./cost-ledger');
const { NOW_ISO_SQL } = require('./now');

const _stmtInsJobRun = db.prepare(
  `INSERT INTO job_runs (job_id, type, book_id, user_email, label, provider, model, status, queued_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ${NOW_ISO_SQL})`
);
const _stmtStartJobRun = db.prepare(
  `UPDATE job_runs SET status = 'running', started_at = ${NOW_ISO_SQL} WHERE job_id = ?`
);
const _stmtEndJobRun = db.prepare(
  `UPDATE job_runs SET status = ?, ended_at = ${NOW_ISO_SQL}, tokens_in = ?, tokens_out = ?, cache_read_in = ?, cache_creation_in = ?, cache_creation_1h_in = ?, tokens_per_sec = ?, error = ?, error_params = ? WHERE job_id = ?`
);

function insertJobRun(job) {
  // bookId normalisieren: System-Jobs (Backfill, Synonym ohne Buch, …) übergeben
  // 0 als „kein Buchkontext". Mig 83 hat die books-Sentinel-Zeile (book_id=0)
  // entfernt → FK `job_runs.book_id REFERENCES books(book_id)` würde brechen.
  // Nicht-positive / nicht-numerische Werte daher als NULL persistieren.
  const bookNum = Number(job.bookId);
  const bookId = Number.isInteger(bookNum) && bookNum > 0 ? bookNum : null;
  _stmtInsJobRun.run(
    job.id, job.type, bookId, job.userEmail || null, job.label || null,
    job.provider || null, job.model || null,
  );
}
function startJobRun(jobId) {
  _stmtStartJobRun.run(jobId);
}
function endJobRun(jobId, status, tokensIn, tokensOut, cacheReadIn, cacheCreationIn, cacheCreation1hIn, tokensPerSec, error, errorParams = null) {
  const paramsJson = errorParams ? JSON.stringify(errorParams) : null;
  _stmtEndJobRun.run(
    status,
    tokensIn || 0, tokensOut || 0,
    cacheReadIn || 0, cacheCreationIn || 0, cacheCreation1hIn || 0,
    tokensPerSec ?? null, error || null, paramsJson, jobId,
  );
  // Eingefrorene Kosten ins persistente Ledger schreiben (chat-sourced Typen
  // werden dort uebersprungen — ihr Verbrauch laeuft ueber chat_messages).
  recordJobLedger(jobId);
}

/** Setzt alle hängenden job_runs (status 'running' oder 'queued') auf 'error'.
 *  Gibt die Anzahl bereinigter Einträge zurück. */
function cleanupStuckJobRuns() {
  const result = db.prepare(
    `UPDATE job_runs SET status = 'error', ended_at = ${NOW_ISO_SQL}, error = 'Job-Prozess gestorben (Server-Neustart oder Absturz)'
     WHERE status IN ('running', 'queued')`
  ).run();
  return result.changes;
}

const _stmtLastDone = db.prepare(`
  SELECT r.job_id, r.started_at, r.ended_at, r.tokens_in, r.tokens_out, l.usd
    FROM job_runs r
    LEFT JOIN ai_cost_ledger l ON l.source_ref = 'job:' || r.job_id
   WHERE r.type = ? AND r.book_id = ? AND r.user_email IS ? AND r.status = 'done'
   ORDER BY r.ended_at DESC
   LIMIT 1
`);
// Rückfall: job_runs hält nur so lange wie `app.job_runs_retention_days` (lib/cache-cleanup.js), das Kostenbuch bleibt.
// Es kennt keinen Status — darum nur Läufe VOR der ältesten job_runs-Zeile: was
// danach liegt, steht noch in job_runs, und fehlt es dort als 'done', war es keiner.
// `ts` ist das Laufende; ein Start ist nicht überliefert. Chat-Typen bucht das
// Kostenbuch nicht als Job — für sie bleibt es bei job_runs.
const _stmtLastLedger = db.prepare(`
  SELECT substr(source_ref, 5) AS job_id, NULL AS started_at, ts AS ended_at,
         tokens_in, tokens_out, usd
    FROM ai_cost_ledger
   WHERE source = 'job' AND type = ? AND book_id = ? AND user_email IS ?
     AND ts < COALESCE((SELECT MIN(queued_at) FROM job_runs), '9999')
   ORDER BY ts DESC
   LIMIT 1
`);

/** Letzter erfolgreicher Lauf eines Job-Typs für Buch + User, auch jenseits der
 *  job_runs-Aufbewahrung; sonst null. */
function lastDoneJobRun(type, bookId, userEmail) {
  const em = userEmail || null;
  return _stmtLastDone.get(type, bookId, em) || _stmtLastLedger.get(type, bookId, em) || null;
}

module.exports = {
  lastDoneJobRun,
  insertJobRun,
  startJobRun,
  endJobRun,
  cleanupStuckJobRuns,
};
