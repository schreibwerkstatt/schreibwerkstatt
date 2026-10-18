'use strict';
// Bild-Cache der Blog-Syncs (Tabelle sync_media_cache, Migration 332): welche
// Bildquelle schon beim Ziel liegt. `owner` ist `{ blogId }` (WordPress) oder
// `{ hubId }` (HubSpot) — genau eins, wie der CHECK der Tabelle.

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');

function _col(owner) {
  if (owner?.blogId != null) return ['blog_id', parseInt(owner.blogId, 10)];
  if (owner?.hubId != null) return ['hub_id', parseInt(owner.hubId, 10)];
  throw new Error('sync-media-cache: owner { blogId } | { hubId } fehlt');
}

const _stmts = {};
function _stmt(col, kind) {
  const k = `${col}:${kind}`;
  if (_stmts[k]) return _stmts[k];
  const sql = {
    get: `SELECT remote_src, remote_id FROM sync_media_cache WHERE ${col} = ? AND src_key = ?`,
    put: `INSERT INTO sync_media_cache (${col}, src_key, remote_src, remote_id, created_at)
          VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})
          ON CONFLICT(${col}, src_key) WHERE ${col} IS NOT NULL
          DO UPDATE SET remote_src = excluded.remote_src, remote_id = excluded.remote_id`,
    clear: `DELETE FROM sync_media_cache WHERE ${col} = ?`,
  }[kind];
  _stmts[k] = db.prepare(sql);
  return _stmts[k];
}

/** `{ src, id }` oder null. */
function getCachedMedia(owner, srcKey) {
  const [col, id] = _col(owner);
  const row = _stmt(col, 'get').get(id, String(srcKey));
  return row ? { src: row.remote_src, id: row.remote_id } : null;
}

function putCachedMedia(owner, srcKey, { src, id = null } = {}) {
  if (!src) return;
  const [col, oid] = _col(owner);
  _stmt(col, 'put').run(oid, String(srcKey), String(src), id == null ? null : String(id));
}

/** Cache einer Verbindung leeren (Zielwechsel, „Verbindung prüfen"). */
function clearCachedMedia(owner) {
  const [col, id] = _col(owner);
  return _stmt(col, 'clear').run(id).changes;
}

module.exports = { getCachedMedia, putCachedMedia, clearCachedMedia };
