'use strict';
// Pflege einzelner Welt-Fakten durch den Autor (Welt-Karte). Jeder Schreibweg hier
// setzt `manually_edited = 1`: der Full-Replace der Komplettanalyse
// (world-facts.js#saveFaktenToDb) lässt solche Zeilen stehen.
//
// Löschen oder Umformulieren einer ANALYSE-Aussage legt eine Unterdrückung an
// (world_fact_suppressions, bei Umformulierung mit `replaced_by` = diese Zeile): sonst
// fände der nächste Lauf die Aussage wieder. Kapitel-Bezüge des Autors (`chapter_ids`)
// stehen als `world_fact_chapters.manual = 1` und überdauern den Neubau der Brücken.

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { normFaktKategorie, factKey } = require('./world-facts');

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

// chapter_ids: Array von Kapitel-IDs dieses Buchs (undefined = unverändert lassen).
function _chapterIds(bookId, raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new WorldFactEditError('INVALID_CHAPTER_IDS');
  const ids = [...new Set(raw.map(v => parseInt(v, 10)).filter(v => v > 0))];
  if (ids.length !== raw.length) throw new WorldFactEditError('INVALID_CHAPTER_IDS');
  if (!ids.length) return [];
  const ok = new Set(db.prepare(`SELECT chapter_id FROM chapters WHERE book_id = ? AND chapter_id IN (${ids.map(() => '?').join(',')})`)
    .all(bookId, ...ids).map(r => r.chapter_id));
  if (ids.some(id => !ok.has(id))) throw new WorldFactEditError('INVALID_CHAPTER_IDS');
  return ids;
}

function _setManualChapters(factId, ids) {
  if (ids === undefined) return;
  db.prepare('DELETE FROM world_fact_chapters WHERE fact_id = ? AND manual = 1').run(factId);
  // Ein schon von der Analyse gesetzter Bezug wird zum manuellen (überdauert den Neubau).
  const up = db.prepare(`INSERT INTO world_fact_chapters (fact_id, chapter_id, manual) VALUES (?, ?, 1)
                          ON CONFLICT(fact_id, chapter_id) DO UPDATE SET manual = 1`);
  for (const c of ids) up.run(factId, c);
}

function _suppress(bookId, userEmail, row, replacedBy) {
  db.prepare(`INSERT INTO world_fact_suppressions (book_id, user_email, fact_key, subjekt, fakt, replaced_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})
              ON CONFLICT DO UPDATE SET replaced_by = excluded.replaced_by`)
    .run(bookId, userEmail || null, factKey(row.subjekt, row.fakt), row.subjekt || null, row.fakt, replacedBy);
}

function _row(bookId, userEmail, id) {
  const factId = parseInt(id, 10);
  if (!factId) return null;
  return db.prepare('SELECT id, subjekt, fakt, manually_edited FROM world_facts WHERE id = ? AND book_id = ? AND user_email IS ?')
    .get(factId, bookId, userEmail || null) || null;
}

/** Neuen Fakt anlegen (vorne einreihen). Body: { fakt, subjekt?, kategorie?, chapter_ids? }. @returns {number} id */
function createWorldFact(bookId, userEmail, body) {
  const f = _fields(body || {}, { partial: false });
  const chapterIds = _chapterIds(bookId, body?.chapter_ids);
  return db.transaction(() => {
    const { m } = db.prepare('SELECT MIN(sort_order) AS m FROM world_facts WHERE book_id = ? AND user_email IS ?')
      .get(bookId, userEmail || null);
    const id = db.prepare(`
      INSERT INTO world_facts (book_id, kategorie, subjekt, fakt, sort_order, user_email, manually_edited, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ${NOW_ISO_SQL})`)
      .run(bookId, f.kategorie, f.subjekt, f.fakt, (m ?? 1) - 1, userEmail || null).lastInsertRowid;
    _setManualChapters(id, chapterIds);
    return id;
  })();
}

/** Fakt ändern (Teilmenge von { fakt, subjekt, kategorie, chapter_ids }); macht ihn zum
 *  gepflegten. Ändert sich der Wortlaut einer Analyse-Aussage, wird das Original
 *  unterdrückt und zeigt auf diese Zeile — seine Fundstellen landen künftig hier. */
function updateWorldFact(bookId, userEmail, id, body) {
  const row = _row(bookId, userEmail, id);
  if (!row) throw new WorldFactEditError('NOT_FOUND', 404);
  const f = _fields(body || {}, { partial: true });
  const chapterIds = _chapterIds(bookId, body?.chapter_ids);
  const neu = { subjekt: 'subjekt' in f ? f.subjekt : row.subjekt, fakt: 'fakt' in f ? f.fakt : row.fakt };
  const reworded = factKey(neu.subjekt, neu.fakt) !== factKey(row.subjekt, row.fakt);
  db.transaction(() => {
    if (!row.manually_edited && reworded) _suppress(bookId, userEmail, row, row.id);
    const sets = Object.keys(f).map(k => `${k} = @${k}`);
    db.prepare(`UPDATE world_facts SET ${[...sets, 'manually_edited = 1', `updated_at = ${NOW_ISO_SQL}`].join(', ')} WHERE id = @id`)
      .run({ ...f, id: row.id });
    _setManualChapters(row.id, chapterIds);
  })();
  return row.id;
}

/** Fakt löschen. Eine Analyse-Aussage wird unterdrückt, damit der nächste Lauf sie nicht
 *  wieder anlegt; Unterdrückungen, die auf einen gepflegten Fakt zeigten, bleiben bestehen
 *  (FK SET NULL) — der Autor hat die Aussage damit zweimal verworfen. */
function deleteWorldFact(bookId, userEmail, id) {
  const row = _row(bookId, userEmail, id);
  if (!row) throw new WorldFactEditError('NOT_FOUND', 404);
  db.transaction(() => {
    if (!row.manually_edited) _suppress(bookId, userEmail, row, null);
    db.prepare('DELETE FROM world_facts WHERE id = ?').run(row.id);
  })();
  return row.id;
}

/** Unterdrückung aufheben: die nächste Analyse darf die Aussage wieder anlegen. */
function restoreSuppressedFact(bookId, userEmail, id) {
  const supId = parseInt(id, 10);
  const r = supId
    ? db.prepare('DELETE FROM world_fact_suppressions WHERE id = ? AND book_id = ? AND user_email IS ?')
      .run(supId, bookId, userEmail || null)
    : { changes: 0 };
  if (!r.changes) throw new WorldFactEditError('NOT_FOUND', 404);
}

module.exports = { WorldFactEditError, createWorldFact, updateWorldFact, deleteWorldFact, restoreSuppressedFact };
