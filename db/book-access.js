'use strict';
// SSoT-Helper fuer book_access + page_locks. Konsumenten (lib/acl.js, Sharing-Routen,
// Apply-only-Routen) gehen ausschliesslich hierdurch.
//
// Rollen-Hierarchie absteigend: owner > editor > lektor > viewer.
// `hasMinRole(actual, required)` und `ROLE_RANK` sind die einzige Stelle, die
// das vergleichen darf — sonst driften Guards.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const ROLE_RANK = { viewer: 1, lektor: 2, editor: 3, owner: 4 };

function _normEmail(e) {
  return (e || '').toString().trim().toLowerCase();
}

function hasMinRole(actual, required) {
  if (!actual || !required) return false;
  const a = ROLE_RANK[actual];
  const r = ROLE_RANK[required];
  return Number.isInteger(a) && Number.isInteger(r) && a >= r;
}

// ── Access ──────────────────────────────────────────────────────────────────

const _stmtGetRole = db.prepare(`
  SELECT role FROM book_access WHERE book_id = ? AND user_email = ?
`);

function getBookRole(bookId, email) {
  const id = parseInt(bookId, 10);
  const e = _normEmail(email);
  if (!Number.isInteger(id) || id <= 0 || !e) return null;
  const row = _stmtGetRole.get(id, e);
  return row?.role || null;
}

const _stmtListBookAccess = db.prepare(`
  SELECT ba.user_email, ba.role, ba.granted_at, ba.granted_by,
         u.display_name
    FROM book_access ba
    LEFT JOIN app_users u ON u.email = ba.user_email
   WHERE ba.book_id = ?
   ORDER BY CASE ba.role
              WHEN 'owner'  THEN 0
              WHEN 'editor' THEN 1
              WHEN 'lektor' THEN 2
              WHEN 'viewer' THEN 3
              ELSE 4
            END, ba.user_email
`);

function listBookAccess(bookId) {
  const id = parseInt(bookId, 10);
  if (!Number.isInteger(id) || id <= 0) return [];
  return _stmtListBookAccess.all(id);
}

const _stmtListBookIdsForUser = db.prepare(`
  SELECT book_id, role FROM book_access WHERE user_email = ?
`);

function listBookIdsForUser(email) {
  const e = _normEmail(email);
  if (!e) return [];
  return _stmtListBookIdsForUser.all(e);
}

const _stmtUpsertAccess = db.prepare(`
  INSERT INTO book_access (book_id, user_email, role, granted_at, granted_by)
  VALUES (?, ?, ?, ${NOW_ISO_SQL}, ?)
  ON CONFLICT(book_id, user_email) DO UPDATE SET
    role       = excluded.role,
    granted_at = ${NOW_ISO_SQL},
    granted_by = excluded.granted_by
`);

function grantAccess(bookId, email, role, grantedBy) {
  const id = parseInt(bookId, 10);
  const e = _normEmail(email);
  if (!Number.isInteger(id) || id <= 0) throw new Error('grantAccess: invalid bookId');
  if (!e) throw new Error('grantAccess: invalid email');
  if (!ROLE_RANK[role]) throw new Error(`grantAccess: invalid role "${role}"`);
  _stmtUpsertAccess.run(id, e, role, _normEmail(grantedBy) || 'system');
}

const _stmtRevokeAccess = db.prepare(`
  DELETE FROM book_access WHERE book_id = ? AND user_email = ?
`);

function revokeAccess(bookId, email) {
  const id = parseInt(bookId, 10);
  const e = _normEmail(email);
  if (!Number.isInteger(id) || id <= 0 || !e) return false;
  return _stmtRevokeAccess.run(id, e).changes > 0;
}

const _stmtFindOwner = db.prepare(`
  SELECT user_email FROM book_access WHERE book_id = ? AND role = 'owner'
`);

function getOwnerEmail(bookId) {
  const id = parseInt(bookId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  return _stmtFindOwner.get(id)?.user_email || null;
}

// Ownership-Transfer: alter Owner wird editor, neuer Owner wird owner.
// Voraussetzung: neuer Owner ist bereits in book_access (egal welche Rolle).
function transferOwnership(bookId, newOwnerEmail, performedBy) {
  const id = parseInt(bookId, 10);
  const e = _normEmail(newOwnerEmail);
  if (!Number.isInteger(id) || id <= 0) throw new Error('transferOwnership: invalid bookId');
  if (!e) throw new Error('transferOwnership: invalid email');
  const newRow = _stmtGetRole.get(id, e);
  if (!newRow) {
    // `code` statt Message-Vergleich: die Route mappt darauf ihren 404.
    const err = new Error('transferOwnership: target not in book_access');
    err.code = 'TARGET_NOT_IN_ACCESS';
    throw err;
  }
  const oldOwner = getOwnerEmail(id);
  db.transaction(() => {
    if (oldOwner && oldOwner !== e) {
      _stmtUpsertAccess.run(id, oldOwner, 'editor', _normEmail(performedBy) || 'system');
    }
    _stmtUpsertAccess.run(id, e, 'owner', _normEmail(performedBy) || 'system');
    // books.owner_email nur ueber den Domänen-Helfer; synchron, laeuft also
    // in derselben Transaktion wie die beiden Grants.
    require('./books').setBookOwner(id, e);
  })();
  return { previousOwner: oldOwner, newOwner: e };
}

// ── Page-Locks ──────────────────────────────────────────────────────────────

const _stmtGetLock = db.prepare(`
  SELECT page_id, book_id, locked_by_email, reason, acquired_at, expires_at, last_heartbeat_at
    FROM page_locks
   WHERE page_id = ?
`);

function getPageLock(pageId) {
  const id = parseInt(pageId, 10);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = _stmtGetLock.get(id);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM page_locks WHERE page_id = ?').run(id);
    return null;
  }
  return row;
}

// Liefert den aktiven Lock NUR wenn er von einem anderen User gehalten wird.
// Der eigene Lock blockt den Holder nicht.
//
// Soft-Lock-Branch: 'edit'-Locks sind advisory (UI-Hint) und sollen den
// PUT-/Apply-Pfad nicht blockieren. Caller, die echte Mutual-Exclusion
// brauchen (Lektorat-Substring-Replace), holen den Lock weiterhin via
// `getPageLock`. PUT/Apply-Handler benutzen diese Funktion, die nur
// 'lektorat' als blockierend zurueckgibt.
function getBlockingLockFor(pageId, currentEmail) {
  const lock = getPageLock(pageId);
  if (!lock) return null;
  if (_normEmail(lock.locked_by_email) === _normEmail(currentEmail)) return null;
  if (lock.reason !== 'lektorat') return null;
  return lock;
}

// Lock-TTL live aus app_settings (editor.lock_ttl_min). Lazy require, weil dies
// ein db/-File ist und lib/app-settings selbst db/ laedt — Top-Level-Require
// koennte einen Import-Zyklus eroeffnen.
function _lockTtlMs() {
  return (require('../lib/app-settings').get('editor.lock_ttl_min') || 30) * 60 * 1000;
}

function _acquireOrExtendLock(pageId, bookId, email, reason) {
  const pid = parseInt(pageId, 10);
  const bid = parseInt(bookId, 10);
  const e = _normEmail(email);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('acquireLock: invalid pageId');
  if (!Number.isInteger(bid) || bid <= 0) throw new Error('acquireLock: invalid bookId');
  if (!e) throw new Error('acquireLock: invalid email');
  const expires = new Date(Date.now() + _lockTtlMs()).toISOString();
  const existing = getPageLock(pid);
  if (existing && _normEmail(existing.locked_by_email) !== e) {
    const err = new Error('PAGE_LOCKED');
    err.code = 'PAGE_LOCKED';
    err.lock = existing;
    throw err;
  }
  db.prepare(`
    INSERT INTO page_locks (page_id, book_id, locked_by_email, reason, acquired_at, expires_at, last_heartbeat_at)
    VALUES (?, ?, ?, ?, ${NOW_ISO_SQL}, ?, ${NOW_ISO_SQL})
    ON CONFLICT(page_id) DO UPDATE SET
      expires_at        = excluded.expires_at,
      last_heartbeat_at = ${NOW_ISO_SQL},
      locked_by_email   = excluded.locked_by_email,
      reason            = excluded.reason
  `).run(pid, bid, e, reason || 'lektorat', expires);
  return getPageLock(pid);
}

function acquireLock(pageId, bookId, email, reason) {
  return _acquireOrExtendLock(pageId, bookId, email, reason);
}

function heartbeatLock(pageId, email) {
  const pid = parseInt(pageId, 10);
  const e = _normEmail(email);
  if (!Number.isInteger(pid) || pid <= 0 || !e) return null;
  const lock = getPageLock(pid);
  if (!lock) return null;
  if (_normEmail(lock.locked_by_email) !== e) {
    const err = new Error('PAGE_LOCKED');
    err.code = 'PAGE_LOCKED';
    err.lock = lock;
    throw err;
  }
  const expires = new Date(Date.now() + _lockTtlMs()).toISOString();
  db.prepare(`
    UPDATE page_locks SET expires_at = ?, last_heartbeat_at = ${NOW_ISO_SQL} WHERE page_id = ?
  `).run(expires, pid);
  return getPageLock(pid);
}

function releaseLock(pageId, email, { force = false } = {}) {
  const pid = parseInt(pageId, 10);
  const e = _normEmail(email);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (force) {
    return db.prepare('DELETE FROM page_locks WHERE page_id = ?').run(pid).changes > 0;
  }
  return db.prepare(
    'DELETE FROM page_locks WHERE page_id = ? AND locked_by_email = ?'
  ).run(pid, e).changes > 0;
}

function purgeExpiredLocks() {
  // ISO-8601-Strings (mit `T`-Separator) sind nicht direkt mit SQLite-`datetime('now')`
  // (Leerzeichen-Separator) lexikografisch vergleichbar — datetime()-Wrapper auf
  // beiden Seiten normalisiert beide Formate.
  return db.prepare(
    "DELETE FROM page_locks WHERE datetime(expires_at) < datetime('now')"
  ).run().changes;
}

module.exports = {
  ROLE_RANK,
  hasMinRole,
  getBookRole,
  listBookAccess,
  listBookIdsForUser,
  grantAccess,
  revokeAccess,
  getOwnerEmail,
  transferOwnership,
  getPageLock,
  getBlockingLockFor,
  acquireLock,
  heartbeatLock,
  releaseLock,
  purgeExpiredLocks,
};
