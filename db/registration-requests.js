'use strict';
// Helper-API ueber registration_requests. Konsumiert von POST /register (oeffentlich) und vom
// Admin-Workflow in /admin/registration-requests (approve/deny/expire).
//
// Pending-Status ist Partial-UNIQUE pro Email: ein Duplikat wirft auf der
// Insert-Seite (SQLITE_CONSTRAINT). Caller faengt das Symptom ab und
// liefert dieselbe 202-Antwort zurueck — keine User-Enumeration.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const EXPIRE_DAYS = 30;

function _normEmail(email) {
  return (email || '').trim().toLowerCase();
}

const _stmtInsert = db.prepare(`
  INSERT INTO registration_requests (email, display_name, message, ip, user_agent, source, source_note, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
`);

const _stmtFindById = db.prepare(`
  SELECT id, email, display_name, message, ip, user_agent, source, source_note, status,
         created_at, reviewed_at, reviewed_by, review_reason, invite_id
    FROM registration_requests
   WHERE id = ?
`);

const _stmtListByStatus = db.prepare(`
  SELECT id, email, display_name, message, ip, user_agent, source, source_note, status,
         created_at, reviewed_at, reviewed_by, review_reason, invite_id
    FROM registration_requests
   WHERE status = ?
   ORDER BY created_at DESC, id DESC
`);

const _stmtListRecent = db.prepare(`
  SELECT id, email, display_name, message, ip, user_agent, source, source_note, status,
         created_at, reviewed_at, reviewed_by, review_reason, invite_id
    FROM registration_requests
   ORDER BY created_at DESC, id DESC
   LIMIT ?
`);

const _stmtApprove = db.prepare(`
  UPDATE registration_requests
     SET status      = 'approved',
         reviewed_at = ${NOW_ISO_SQL},
         reviewed_by = ?,
         invite_id   = ?
   WHERE id = ? AND status = 'pending'
`);

const _stmtDeny = db.prepare(`
  UPDATE registration_requests
     SET status        = 'denied',
         reviewed_at   = ${NOW_ISO_SQL},
         reviewed_by   = ?,
         review_reason = ?
   WHERE id = ? AND status = 'pending'
`);

const _stmtExpireOlderThan = db.prepare(`
  UPDATE registration_requests
     SET status = 'expired'
   WHERE status = 'pending'
     AND datetime(created_at) < datetime('now', ?)
`);

// Insert. Wirft bei pending-Duplikat (Partial-UNIQUE). Caller darf das
// schlucken — Antwort an den Public-Caller bleibt gleich (kein Leak).
function createRequest({ email, displayName = null, message = null, ip = null, userAgent = null, source = null, sourceNote = null }) {
  const e = _normEmail(email);
  if (!e) throw new Error('createRequest: email required');
  const info = _stmtInsert.run(e, displayName || null, message || null, ip || null, userAgent || null,
    source || null, sourceNote || null);
  return _stmtFindById.get(info.lastInsertRowid);
}

function getRequest(id) {
  return _stmtFindById.get(Number(id)) || null;
}

function listPending() {
  return _stmtListByStatus.all('pending');
}

function listByStatus(status) {
  return _stmtListByStatus.all(status);
}

function listRecent(limit = 200) {
  return _stmtListRecent.all(Math.max(1, Math.min(1000, limit)));
}

function approveRequest(id, { reviewer, inviteId }) {
  const r = _stmtApprove.run(_normEmail(reviewer), inviteId || null, Number(id));
  if (r.changes === 0) return null;
  return _stmtFindById.get(Number(id));
}

function denyRequest(id, { reviewer, reason = null }) {
  const r = _stmtDeny.run(_normEmail(reviewer), reason || null, Number(id));
  if (r.changes === 0) return null;
  return _stmtFindById.get(Number(id));
}

// Pending-Requests aelter als EXPIRE_DAYS auf 'expired' setzen.
// Liefert Anzahl betroffener Zeilen — fuer Cron-Log-Output.
function expireStale(days = EXPIRE_DAYS) {
  const d = Math.max(1, Math.min(365, Number(days) || EXPIRE_DAYS));
  const r = _stmtExpireOlderThan.run(`-${d} days`);
  return r.changes;
}

module.exports = {
  EXPIRE_DAYS,
  createRequest, getRequest,
  listPending, listByStatus, listRecent,
  approveRequest, denyRequest,
  expireStale,
};
