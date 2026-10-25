'use strict';
// Exposé: Historie der Läufe (`book_exposes`) und der interne Inhaltsangaben-
// Cache des Multi-Pass (`expose_synopsis_cache`). Beide hier zusammen, weil sie
// nur einen Konsumenten haben (routes/jobs/expose.js + routes/expose.js).
// Was im Exposé NICHT gespeichert wird (Titel, Autor, Klappentext, Zielgruppe …),
// steht in Migration 0340.

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { requireUserEmail } = require('./write-helpers');
const { activeFigureSql } = require('./figures/active');

function _json(s, fallback = null) {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

function _row(r) {
  if (!r) return null;
  return {
    id: r.id,
    profil: r.profil,
    basis: r.basis,
    result: _json(r.result_json, {}),
    edited: _json(r.edited_json, null),
    warnungen: _json(r.warnungen_json, []),
    model: r.model || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// ── Historie ──────────────────────────────────────────────────────────────────
const _latest = db.prepare(
  `SELECT * FROM book_exposes WHERE book_id = ? AND user_email = ?
   ORDER BY created_at DESC, id DESC LIMIT 1`
);
const _list = db.prepare(
  `SELECT id, profil, basis, model, created_at, updated_at, (edited_json IS NOT NULL) AS has_edits
   FROM book_exposes WHERE book_id = ? AND user_email = ?
   ORDER BY created_at DESC, id DESC`
);
const _get = db.prepare(`SELECT * FROM book_exposes WHERE id = ? AND book_id = ? AND user_email = ?`);
const _insert = db.prepare(
  `INSERT INTO book_exposes (book_id, user_email, profil, basis, sig, result_json, warnungen_json, model, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})`
);
const _setEdited = db.prepare(
  `UPDATE book_exposes SET edited_json = ?, updated_at = ${NOW_ISO_SQL}
   WHERE id = ? AND book_id = ? AND user_email = ?`
);
const _delete = db.prepare(`DELETE FROM book_exposes WHERE id = ? AND book_id = ? AND user_email = ?`);

/** Neuer Lauf in die Historie. Trägt die jüngste Zeile dieselbe Signatur
 *  (unveränderte Eingabe), entsteht keine zweite: Rückgabe `{ id, unchanged: true }`. */
function insertExpose({ bookId, userEmail, profil, basis, sig, result, warnungen, model }) {
  const email = requireUserEmail(userEmail, 'expose');
  const latest = _latest.get(bookId, email);
  if (latest && latest.sig === sig) return { id: latest.id, unchanged: true };
  const r = _insert.run(bookId, email, profil, basis, sig, JSON.stringify(result),
    JSON.stringify(warnungen || []), model || null);
  return { id: Number(r.lastInsertRowid), unchanged: false };
}

/** Jüngster Lauf mit dieser Signatur (Cache-Treffer des Endergebnisses) oder null. */
function findExposeBySig(bookId, userEmail, sig) {
  const latest = _latest.get(bookId, requireUserEmail(userEmail, 'expose'));
  return latest && latest.sig === sig ? _row(latest) : null;
}

function latestExpose(bookId, userEmail) {
  return _row(_latest.get(bookId, requireUserEmail(userEmail, 'expose')));
}

function listExposes(bookId, userEmail) {
  return _list.all(bookId, requireUserEmail(userEmail, 'expose')).map(r => ({ ...r, has_edits: !!r.has_edits }));
}

function getExpose(bookId, userEmail, id) {
  return _row(_get.get(id, bookId, requireUserEmail(userEmail, 'expose')));
}

/** Autorfassung setzen (`null` = zurück zur KI-Fassung). Liefert false, wenn die
 *  Zeile nicht (mehr) existiert oder nicht diesem User gehört. */
function setExposeEdited(bookId, userEmail, id, edited) {
  const r = _setEdited.run(edited == null ? null : JSON.stringify(edited), id, bookId, requireUserEmail(userEmail, 'expose'));
  return r.changes > 0;
}

function deleteExpose(bookId, userEmail, id) {
  return _delete.run(id, bookId, requireUserEmail(userEmail, 'expose')).changes > 0;
}

// ── Figurenkatalog fürs Exposé ────────────────────────────────────────────────
// Aktive Figuren mit den Feldern, die eine Figurenliste trägt (Rolle, Motivation,
// Konflikt, Entwicklung). `id` = die öffentliche fig_id (dieselbe Achse wie der
// Figurenkatalog im Frontend und x-entity-ref) — das Exposé speichert nur sie,
// der Name kommt beim Anzeigen live aus dem Katalog.
const _figuren = db.prepare(
  `SELECT f.fig_id AS id, f.name, f.typ, f.rolle, f.motivation, f.konflikt, f.entwicklung
   FROM figures f WHERE f.book_id = ? AND f.user_email = ? AND ${activeFigureSql('f')}
   ORDER BY f.sort_order, f.id`
);

function listExposeFiguren(bookId, userEmail) {
  return _figuren.all(bookId, requireUserEmail(userEmail, 'expose'));
}

// Zeichen des Buchs aus page_stats (gleiche Normalisierung wie Statistik und
// Metrik) — Grundlage der Umfangsangabe in Normseiten.
const _bookChars = db.prepare(`SELECT COALESCE(SUM(chars), 0) AS chars FROM page_stats WHERE book_id = ?`);

function bookChars(bookId) {
  return _bookChars.get(bookId).chars;
}

// ── Inhaltsangaben-Cache (Multi-Pass) ─────────────────────────────────────────
const _loadSyn = db.prepare(
  `SELECT inhalt_json FROM expose_synopsis_cache
   WHERE book_id = ? AND user_email = ? AND provider = ? AND sig = ?`
);
const _saveSyn = db.prepare(
  `INSERT OR REPLACE INTO expose_synopsis_cache (book_id, user_email, provider, sig, inhalt_json, created_at)
   VALUES (?, ?, ?, ?, ?, ${NOW_ISO_SQL})`
);
const _listSynSigs = db.prepare(
  `SELECT sig FROM expose_synopsis_cache WHERE book_id = ? AND user_email = ? AND provider = ?`
);
const _deleteSyn = db.prepare(
  `DELETE FROM expose_synopsis_cache WHERE book_id = ? AND user_email = ? AND provider = ? AND sig = ?`
);

function loadSynopsisCache(bookId, userEmail, provider, sig) {
  const row = _loadSyn.get(bookId, requireUserEmail(userEmail, 'expose'), provider || '', sig);
  return row ? _json(row.inhalt_json, null) : null;
}

function saveSynopsisCache(bookId, userEmail, provider, sig, inhalt) {
  _saveSyn.run(bookId, requireUserEmail(userEmail, 'expose'), provider || '', sig, JSON.stringify(inhalt));
}

/** Entfernt Einträge, deren Signatur der letzte Lauf nicht mehr gebraucht hat
 *  (geänderte Kapitel). Pro Provider — ein anderer Provider behält seinen Stand. */
function pruneSynopsisCache(bookId, userEmail, provider, keepSigs) {
  const email = requireUserEmail(userEmail, 'expose');
  const keep = new Set(keepSigs);
  let n = 0;
  db.transaction(() => {
    for (const { sig } of _listSynSigs.all(bookId, email, provider || '')) {
      if (!keep.has(sig)) n += _deleteSyn.run(bookId, email, provider || '', sig).changes;
    }
  })();
  return n;
}

module.exports = {
  insertExpose, findExposeBySig, latestExpose, listExposes, getExpose, setExposeEdited, deleteExpose,
  loadSynopsisCache, saveSynopsisCache, pruneSynopsisCache,
  listExposeFiguren, bookChars,
};
