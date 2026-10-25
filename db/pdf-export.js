'use strict';
// CRUD fuer pdf_export_profile (multiple Profile pro Buch+User).
// Cover-Bild als BLOB direkt im Profil. JSON-Config-Field als String persistiert.
//
// Seit Mig 83: scope = (kind, book_id):
//   kind='book'         + book_id NOT NULL → buch-spezifisches Profil
//   kind='user_default' + book_id NULL     → buchunabhaengige Vorlage
// API-Aufrufer uebergeben weiterhin bookId; intern uebersetzt _scope() in
// (kind, book_id). bookId<=0 / null / undefined → user_default-Scope.
// Pro Scope max. ein Profil mit is_default=1.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { validateConfig, defaultConfig } = require('../lib/pdf-export-defaults');
const logger = require('../logger');

function _scope(bookId) {
  const id = parseInt(bookId);
  if (!Number.isInteger(id) || id <= 0) return { kind: 'user_default', bookId: null };
  return { kind: 'book', bookId: id };
}

const _SELECT_COLS = `id, book_id, kind, user_email, name, config_json, is_default,
       (back_cover_image IS NOT NULL) AS has_back_cover, back_cover_image_mime,
       (spine_image IS NOT NULL) AS has_spine, spine_image_mime,
       created_at, updated_at`;

const _stmtListBook = db.prepare(
  `SELECT ${_SELECT_COLS} FROM pdf_export_profile
    WHERE kind = 'book' AND book_id = ? AND user_email = ?
    ORDER BY is_default DESC, name COLLATE NOCASE ASC`
);
const _stmtListUserDefault = db.prepare(
  `SELECT ${_SELECT_COLS} FROM pdf_export_profile
    WHERE kind = 'user_default' AND user_email = ?
    ORDER BY is_default DESC, name COLLATE NOCASE ASC`
);
const _stmtGet = db.prepare(`SELECT ${_SELECT_COLS} FROM pdf_export_profile WHERE id = ?`);
const _stmtGetBackCover = db.prepare(
  `SELECT back_cover_image AS image, back_cover_image_mime AS mime FROM pdf_export_profile WHERE id = ?`
);
const _stmtGetSpine = db.prepare(
  `SELECT spine_image AS image, spine_image_mime AS mime FROM pdf_export_profile WHERE id = ?`
);
const _stmtInsert = db.prepare(
  `INSERT INTO pdf_export_profile (book_id, kind, user_email, name, config_json, is_default, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, 0, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})`
);
const _stmtUpdate = db.prepare(
  `UPDATE pdf_export_profile SET name = ?, config_json = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?`
);
const _stmtDelete = db.prepare(`DELETE FROM pdf_export_profile WHERE id = ?`);
const _stmtSetBackCover = db.prepare(
  `UPDATE pdf_export_profile SET back_cover_image = ?, back_cover_image_mime = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?`
);
const _stmtClearBackCover = db.prepare(
  `UPDATE pdf_export_profile SET back_cover_image = NULL, back_cover_image_mime = NULL, updated_at = ${NOW_ISO_SQL} WHERE id = ?`
);
const _stmtSetSpine = db.prepare(
  `UPDATE pdf_export_profile SET spine_image = ?, spine_image_mime = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?`
);
const _stmtClearSpine = db.prepare(
  `UPDATE pdf_export_profile SET spine_image = NULL, spine_image_mime = NULL, updated_at = ${NOW_ISO_SQL} WHERE id = ?`
);
const _stmtClearDefaultsBook = db.prepare(
  `UPDATE pdf_export_profile SET is_default = 0
    WHERE kind = 'book' AND book_id = ? AND user_email = ?`
);
const _stmtClearDefaultsUserDefault = db.prepare(
  `UPDATE pdf_export_profile SET is_default = 0
    WHERE kind = 'user_default' AND user_email = ?`
);
const _stmtSetDefaultForId = db.prepare(
  `UPDATE pdf_export_profile SET is_default = 1, updated_at = ${NOW_ISO_SQL} WHERE id = ?`
);

// Eine korrupte config_json-Zeile darf weder das Listing noch das Laden eines
// Profils sprengen: Fallback auf die Default-Konfiguration + Warnung im Log.
// Der naechste Speichervorgang ueberschreibt die Zeile mit gueltigem JSON.
function _parseConfig(r) {
  try {
    return validateConfig(JSON.parse(r.config_json));
  } catch (e) {
    logger.warn(`pdf_export_profile ${r.id}: config_json unlesbar (${e.message}) — Default-Konfiguration verwendet`);
    return defaultConfig();
  }
}

function _row(r) {
  if (!r) return null;
  return {
    id: r.id,
    book_id: r.book_id,
    kind: r.kind,
    user_email: r.user_email,
    name: r.name,
    config: _parseConfig(r),
    is_default: !!r.is_default,
    has_back_cover: !!r.has_back_cover,
    back_cover_mime: r.back_cover_image_mime || null,
    has_spine: !!r.has_spine,
    spine_mime: r.spine_image_mime || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function listProfiles(bookId, userEmail) {
  const s = _scope(bookId);
  const rows = s.kind === 'book'
    ? _stmtListBook.all(s.bookId, userEmail)
    : _stmtListUserDefault.all(userEmail);
  return rows.map(_row);
}

function getProfile(id) {
  return _row(_stmtGet.get(parseInt(id)));
}

function createProfile(bookId, userEmail, name, config) {
  const s = _scope(bookId);
  const info = _stmtInsert.run(s.bookId, s.kind, userEmail, name, JSON.stringify(config));
  return getProfile(info.lastInsertRowid);
}

function updateProfile(id, name, config) {
  _stmtUpdate.run(name, JSON.stringify(config), parseInt(id));
  return getProfile(id);
}

function deleteProfile(id) {
  _stmtDelete.run(parseInt(id));
}

function setBackCover(id, buffer, mime) {
  _stmtSetBackCover.run(buffer, mime, parseInt(id));
}

function clearBackCover(id) {
  _stmtClearBackCover.run(parseInt(id));
}

function getBackCover(id) {
  const r = _stmtGetBackCover.get(parseInt(id));
  if (!r || !r.image) return null;
  return { image: r.image, mime: r.mime };
}

function setSpineImage(id, buffer, mime) {
  _stmtSetSpine.run(buffer, mime, parseInt(id));
}

function clearSpineImage(id) {
  _stmtClearSpine.run(parseInt(id));
}

function getSpineImage(id) {
  const r = _stmtGetSpine.get(parseInt(id));
  if (!r || !r.image) return null;
  return { image: r.image, mime: r.mime };
}

const _setDefaultTx = db.transaction((bookId, userEmail, id) => {
  const s = _scope(bookId);
  if (s.kind === 'book') _stmtClearDefaultsBook.run(s.bookId, userEmail);
  else                   _stmtClearDefaultsUserDefault.run(userEmail);
  _stmtSetDefaultForId.run(parseInt(id));
});

function setDefault(bookId, userEmail, id) {
  _setDefaultTx(bookId, userEmail, id);
  return getProfile(id);
}

module.exports = {
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  setBackCover, clearBackCover, getBackCover,
  setSpineImage, clearSpineImage, getSpineImage,
  setDefault,
};
