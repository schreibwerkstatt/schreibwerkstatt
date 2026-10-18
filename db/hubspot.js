'use strict';
// CRUD for hubspot_connections (HubSpot-PAT + Blog/Author-Wahl pro Buch) und
// hubspot_page_links (HubSpot-Post ↔ Page-Mapping nach Push). Token wird via
// lib/crypto.js verschluesselt; getConnection() liefert Klartext, Routes
// duerfen ihn nie an Clients leaken.

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { encrypt, decrypt } = require('../lib/crypto');
const { clearCachedMedia } = require('./sync-media-cache');

// ── hubspot_connections ─────────────────────────────────────────────────────

const _stmtGetByBook = db.prepare(`
  SELECT id, book_id, token_enc, blog_id, author_id, portal_id,
         initial_import_done_at, last_import_at, last_push_at,
         created_at, updated_at
    FROM hubspot_connections
   WHERE book_id = ?
`);

function _decryptRow(row) {
  if (!row) return null;
  const stored = row.token_enc;
  const asString = Buffer.isBuffer(stored) ? stored.toString('utf8') : String(stored || '');
  return {
    id: row.id,
    bookId: row.book_id,
    token: decrypt(asString),
    blogId: row.blog_id,
    authorId: row.author_id,
    portalId: row.portal_id,
    initialImportDoneAt: row.initial_import_done_at,
    lastImportAt: row.last_import_at,
    lastPushAt: row.last_push_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function _publicRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    bookId: row.book_id,
    blogId: row.blog_id,
    authorId: row.author_id,
    portalId: row.portal_id,
    initialImportDoneAt: row.initial_import_done_at,
    lastImportAt: row.last_import_at,
    lastPushAt: row.last_push_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getConnection(bookId) {
  return _decryptRow(_stmtGetByBook.get(parseInt(bookId, 10)));
}

function getConnectionPublic(bookId) {
  return _publicRow(_stmtGetByBook.get(parseInt(bookId, 10)));
}

const _stmtInsert = db.prepare(`
  INSERT INTO hubspot_connections (book_id, token_enc, blog_id, author_id, portal_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
`);

const _stmtUpdate = db.prepare(`
  UPDATE hubspot_connections
     SET token_enc = ?, blog_id = ?, author_id = ?, portal_id = COALESCE(?, portal_id), updated_at = ${NOW_ISO_SQL}
   WHERE id = ?
`);

// Zielwechsel (anderer Blog oder anderes Portal): die bisherigen Links zeigen auf
// Posts des alten Ziels. Bleiben sie stehen, aktualisiert der naechste Push den
// Post im FALSCHEN Blog (Post-IDs sind portalweit eindeutig). Darum fallen sie
// mit dem Wechsel weg, und der Import-Stand beginnt neu.
const _stmtResetTarget = db.prepare(`
  UPDATE hubspot_connections
     SET initial_import_done_at = NULL, last_import_at = NULL, last_push_at = NULL
   WHERE id = ?
`);
const _stmtDeleteLinksForConn = db.prepare('DELETE FROM hubspot_page_links WHERE hub_id = ?');

function _targetChanged(existing, blogId, portalId) {
  if (String(existing.blog_id) !== String(blogId)) return true;
  return portalId != null && existing.portal_id != null && String(existing.portal_id) !== String(portalId);
}

/** Speichert die Verbindung. Rueckgabe: Public-Meta plus `targetChanged`
 *  (true = Links und Import-Stand wurden verworfen). */
function upsertConnection({ bookId, token, blogId, authorId, portalId = null }) {
  const bid = parseInt(bookId, 10);
  if (!Number.isInteger(bid) || bid <= 0) throw new Error('hubspot.upsert: invalid bookId');
  if (!token || typeof token !== 'string') throw new Error('hubspot.upsert: token required');
  if (!blogId || typeof blogId !== 'string') throw new Error('hubspot.upsert: blogId required');
  if (!authorId || typeof authorId !== 'string') throw new Error('hubspot.upsert: authorId required');

  const enc = encrypt(token);
  const pid = portalId == null ? null : String(portalId);
  let targetChanged = false;
  db.transaction(() => {
    const existing = _stmtGetByBook.get(bid);
    if (existing) {
      targetChanged = _targetChanged(existing, blogId, pid);
      _stmtUpdate.run(enc, blogId, authorId, pid, existing.id);
      if (targetChanged) {
        _stmtDeleteLinksForConn.run(existing.id);
        _stmtResetTarget.run(existing.id);
        // File-Manager-Adressen des alten Portals gelten im neuen nicht.
        clearCachedMedia({ hubId: existing.id });
      }
    } else {
      _stmtInsert.run(bid, enc, blogId, authorId, pid);
    }
  })();
  return { ...getConnectionPublic(bid), targetChanged };
}

const _stmtSetPortalId = db.prepare(`
  UPDATE hubspot_connections SET portal_id = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);
function setPortalId(connId, portalId) {
  if (portalId == null || portalId === '') return false;
  return _stmtSetPortalId.run(String(portalId), parseInt(connId, 10)).changes > 0;
}

const _stmtMarkImported = db.prepare(`
  UPDATE hubspot_connections
     SET initial_import_done_at = ${NOW_ISO_SQL}, last_import_at = ${NOW_ISO_SQL}, updated_at = ${NOW_ISO_SQL}
   WHERE id = ?
`);
function markInitialImportDone(connId) {
  _stmtMarkImported.run(parseInt(connId, 10));
}

const _stmtTouchPush = db.prepare(`
  UPDATE hubspot_connections SET last_push_at = ${NOW_ISO_SQL}, updated_at = ${NOW_ISO_SQL} WHERE id = ?
`);
function touchPush(connId) {
  _stmtTouchPush.run(parseInt(connId, 10));
}

const _stmtDelete = db.prepare('DELETE FROM hubspot_connections WHERE book_id = ?');
function deleteConnection(bookId) {
  return _stmtDelete.run(parseInt(bookId, 10)).changes > 0;
}

// ── hubspot_page_links ──────────────────────────────────────────────────────

const LINK_COLS = `page_id, hub_id, hubspot_post_id, hubspot_state, hubspot_created_at,
         hubspot_updated_at, last_pushed_at, last_pulled_at, hubspot_url, conflict_state`;
const CONFLICT_STATES = ['detected', 'resolved-app', 'resolved-remote'];

const _stmtGetLinkByPage = db.prepare(`SELECT ${LINK_COLS} FROM hubspot_page_links WHERE page_id = ?`);
function getLinkByPage(pageId) {
  return _stmtGetLinkByPage.get(parseInt(pageId, 10)) || null;
}

const _stmtGetLinkByPost = db.prepare(`
  SELECT ${LINK_COLS} FROM hubspot_page_links WHERE hub_id = ? AND hubspot_post_id = ?
`);
function getLinkByPost(hubId, hubspotPostId) {
  return _stmtGetLinkByPost.get(parseInt(hubId, 10), String(hubspotPostId)) || null;
}

// `headline_updated_at`: Titel-Werkstatt-Edits (Titel/Lead/Teaser gehen mit
// dem Push raus) bewegen `pages.updated_at` nicht — der Badge braucht beide.
const _stmtListLinksForConn = db.prepare(`
  SELECT l.page_id, l.hub_id, l.hubspot_post_id, l.hubspot_state, l.hubspot_created_at,
         l.hubspot_updated_at, l.last_pushed_at, l.last_pulled_at, l.hubspot_url,
         l.conflict_state, h.updated_at AS headline_updated_at
    FROM hubspot_page_links l
    LEFT JOIN page_headline h ON h.page_id = l.page_id
   WHERE l.hub_id = ?
`);
function listLinksForConnection(hubId) {
  return _stmtListLinksForConn.all(parseInt(hubId, 10));
}

// Ein Push (oder Import) ist ein Sync-Punkt: er setzt den Konfliktstatus zurueck.
const _stmtUpsertLink = db.prepare(`
  INSERT INTO hubspot_page_links
    (page_id, hub_id, hubspot_post_id, hubspot_state, hubspot_created_at,
     hubspot_updated_at, last_pushed_at, hubspot_url, conflict_state)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  ON CONFLICT(page_id) DO UPDATE SET
    hub_id             = excluded.hub_id,
    hubspot_post_id    = excluded.hubspot_post_id,
    hubspot_state      = COALESCE(excluded.hubspot_state, hubspot_page_links.hubspot_state),
    hubspot_created_at = COALESCE(excluded.hubspot_created_at, hubspot_page_links.hubspot_created_at),
    hubspot_updated_at = COALESCE(excluded.hubspot_updated_at, hubspot_page_links.hubspot_updated_at),
    last_pushed_at     = COALESCE(excluded.last_pushed_at, hubspot_page_links.last_pushed_at),
    hubspot_url        = COALESCE(excluded.hubspot_url, hubspot_page_links.hubspot_url),
    conflict_state     = NULL
`);

function upsertLink({
  pageId, hubId, hubspotPostId, hubspotState = null, hubspotCreatedAt = null,
  hubspotUpdatedAt = null, lastPushedAt = null, hubspotUrl = null,
}) {
  _stmtUpsertLink.run(
    parseInt(pageId, 10),
    parseInt(hubId, 10),
    String(hubspotPostId),
    hubspotState,
    hubspotCreatedAt,
    hubspotUpdatedAt || null,
    lastPushedAt,
    hubspotUrl,
  );
  return getLinkByPage(pageId);
}

const _stmtSetConflict = db.prepare('UPDATE hubspot_page_links SET conflict_state = ? WHERE page_id = ?');
function setConflictState(pageId, state) {
  if (state !== null && !CONFLICT_STATES.includes(state)) throw new Error('hubspot.setConflictState: invalid');
  _stmtSetConflict.run(state, parseInt(pageId, 10));
}

// Konflikt zugunsten der App: der gesehene Draft-Stand gilt als bekannt, sonst
// meldete die naechste Vorab-Pruefung denselben HubSpot-Edit wieder.
const _stmtResolveApp = db.prepare(`
  UPDATE hubspot_page_links SET hubspot_updated_at = ?, conflict_state = 'resolved-app' WHERE page_id = ?
`);
function markConflictResolvedApp(pageId, remoteUpdatedAt) {
  _stmtResolveApp.run(String(remoteUpdatedAt || '') || null, parseInt(pageId, 10));
}

// „HubSpot uebernehmen": der Draft-Stand ist jetzt der gemeinsame Stand.
const _stmtMarkPulled = db.prepare(`
  UPDATE hubspot_page_links
     SET hubspot_updated_at = ?, last_pulled_at = ${NOW_ISO_SQL}, conflict_state = NULL
   WHERE page_id = ?
`);
function markLinkPulled(pageId, { remoteUpdatedAt }) {
  _stmtMarkPulled.run(String(remoteUpdatedAt || '') || null, parseInt(pageId, 10));
}

// Abgleich: Status und URL des Remote nachziehen (in HubSpot publiziert → die
// „Ansehen"-Aktion zeigt den Live-Post statt den Editor-Link des Entwurfs).
const _stmtRefreshMeta = db.prepare(`
  UPDATE hubspot_page_links
     SET hubspot_state = COALESCE(?, hubspot_state), hubspot_url = COALESCE(?, hubspot_url)
   WHERE page_id = ?
`);
function refreshLinkMeta(pageId, { hubspotState = null, hubspotUrl = null } = {}) {
  return _stmtRefreshMeta.run(hubspotState, hubspotUrl, parseInt(pageId, 10)).changes > 0;
}

const _stmtDeleteLink = db.prepare('DELETE FROM hubspot_page_links WHERE page_id = ?');
function deleteLink(pageId) {
  return _stmtDeleteLink.run(parseInt(pageId, 10)).changes > 0;
}

module.exports = {
  getConnection,
  getConnectionPublic,
  upsertConnection,
  setPortalId,
  markInitialImportDone,
  touchPush,
  deleteConnection,
  getLinkByPage,
  getLinkByPost,
  listLinksForConnection,
  upsertLink,
  setConflictState,
  markConflictResolvedApp,
  markLinkPulled,
  refreshLinkMeta,
  deleteLink,
};
