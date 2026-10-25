'use strict';
// Pflege einzelner Welt-Fakten durch den Autor (Welt-Karte). Jeder Schreibweg hier
// setzt `manually_edited = 1`: der Full-Replace der Komplettanalyse
// (world-facts.js#saveFaktenToDb) lässt solche Zeilen stehen.

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { normFaktKategorie } = require('./world-facts');

const MAX_FAKT = 2000;
const MAX_SUBJEKT = 200;

class WorldFactEditError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function _fields(body, { partial }) {
  const out = {};
  if (!partial || body.fakt !== undefined) {
    const fakt = String(body.fakt ?? '').trim();
    if (!fakt) throw new WorldFactEditError('FAKT_REQUIRED');
    if (fakt.length > MAX_FAKT) throw new WorldFactEditError('FAKT_TOO_LONG');
    out.fakt = fakt;
  }
  if (!partial || body.subjekt !== undefined) {
    const subjekt = String(body.subjekt ?? '').trim();
    if (subjekt.length > MAX_SUBJEKT) throw new WorldFactEditError('SUBJEKT_TOO_LONG');
    out.subjekt = subjekt || null;
  }
  if (!partial || body.kategorie !== undefined) out.kategorie = normFaktKategorie(body.kategorie);
  return out;
}

function _row(bookId, userEmail, id) {
  const factId = parseInt(id, 10);
  if (!factId) return null;
  return db.prepare('SELECT id FROM world_facts WHERE id = ? AND book_id = ? AND user_email IS ?')
    .get(factId, bookId, userEmail || null) || null;
}

/** Neuen Fakt anlegen (vorne einreihen). Body: { fakt, subjekt?, kategorie? }. @returns {number} id */
function createWorldFact(bookId, userEmail, body) {
  const f = _fields(body || {}, { partial: false });
  const { m } = db.prepare('SELECT MIN(sort_order) AS m FROM world_facts WHERE book_id = ? AND user_email IS ?')
    .get(bookId, userEmail || null);
  return db.prepare(`
    INSERT INTO world_facts (book_id, kategorie, subjekt, fakt, sort_order, user_email, manually_edited, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ${NOW_ISO_SQL})`)
    .run(bookId, f.kategorie, f.subjekt, f.fakt, (m ?? 1) - 1, userEmail || null).lastInsertRowid;
}

/** Fakt ändern (Teilmenge von { fakt, subjekt, kategorie }); macht ihn zum gepflegten. */
function updateWorldFact(bookId, userEmail, id, body) {
  const row = _row(bookId, userEmail, id);
  if (!row) throw new WorldFactEditError('NOT_FOUND', 404);
  const f = _fields(body || {}, { partial: true });
  const sets = Object.keys(f).map(k => `${k} = @${k}`);
  db.prepare(`UPDATE world_facts SET ${[...sets, 'manually_edited = 1', `updated_at = ${NOW_ISO_SQL}`].join(', ')} WHERE id = @id`)
    .run({ ...f, id: row.id });
  return row.id;
}

/** Fakt löschen. Eine Analyse-Aussage kann der nächste Lauf wiederfinden. */
function deleteWorldFact(bookId, userEmail, id) {
  const row = _row(bookId, userEmail, id);
  if (!row) throw new WorldFactEditError('NOT_FOUND', 404);
  db.prepare('DELETE FROM world_facts WHERE id = ?').run(row.id);
  return row.id;
}

module.exports = { WorldFactEditError, createWorldFact, updateWorldFact, deleteWorldFact };
