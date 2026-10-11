'use strict';
// Lesepfade der Komplettanalyse-Indikation (lib/komplett-delta.js, Route
// GET /jobs/komplett-delta/:book_id): letzter erfolgreicher Lauf, der Text, den er
// gelesen hat (jüngste Revision bis zu seinem Start), und Löschungen seither.
const { db } = require('./connection');
require('./migrations');
const { lastDoneJobRun } = require('./job-runs');

/** Letzter erfolgreicher Lauf für Buch + User, oder null (auch jenseits der
 *  job_runs-Aufbewahrung, siehe db/job-runs.js#lastDoneJobRun). */
function lastKomplettRun(bookId, userEmail) {
  return lastDoneJobRun('komplett-analyse', bookId, userEmail);
}

// Pro Seite: jüngste Revision bis `since` (Basis) und die älteste überhaupt
// (eine Seite, deren erste Revision nach `since` liegt, ist seither entstanden).
// Die Revisions-Retention dünnt ältere Stände aus (db/page-revisions.js#pruneTiered):
// die Basis kann darum älter sein als der Lauf — `base_at` geht mit zurück, damit
// der Aufrufer das als Näherung kennzeichnen kann.
const _baseline = db.prepare(`
  SELECT body_html, created_at FROM page_revisions
   WHERE page_id = ? AND created_at <= ?
   ORDER BY created_at DESC, id DESC
   LIMIT 1
`);
const _firstRev = db.prepare(`
  SELECT MIN(created_at) AS first_at FROM page_revisions WHERE page_id = ?
`);

/** Map pageId → { html, baseAt } | { created: true } | { unknown: true }. */
function revisionBaselines(pageIds, sinceIso) {
  const out = new Map();
  for (const id of pageIds) {
    const row = _baseline.get(id, sinceIso);
    if (row) { out.set(id, { html: row.body_html, baseAt: row.created_at }); continue; }
    const first = _firstRev.get(id)?.first_at;
    out.set(id, first ? { created: true } : { unknown: true });
  }
  return out;
}

const _deletions = db.prepare(`
  SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body_html)), 0) AS html_len
    FROM page_deletions
   WHERE book_id = ? AND deleted_at > ? AND restored_at IS NULL
`);

/** Seit `sinceIso` gelöschte (nicht wiederhergestellte) Abschnitte. */
function deletionsSince(bookId, sinceIso) {
  return _deletions.get(bookId, sinceIso);
}

module.exports = { lastKomplettRun, revisionBaselines, deletionsSince };
