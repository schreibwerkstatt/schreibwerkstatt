'use strict';
// Manuelle Pflege des Schauplatz-Katalogs (docs/schauplaetze.md): anlegen, Stammdaten
// korrigieren, Elternort setzen, Analyse-Werte wiederherstellen, löschen. Gegenstück
// zum Analyse-Schreibpfad db/locations-write.js#saveOrteToDb, der die hier gesetzten
// Flags respektiert:
//   manual_fields    → die Analyse überschreibt genau diese Stammdatenfelder nicht
//                      (manually_edited = «mindestens eins», db/location-fields.js)
//   manually_created → die Analyse markiert den Ort nie «nicht mehr im Text»
// `parent_id` fasst die Analyse gar nicht an — die Hierarchie pflegt nur der Autor.
//
// Alle Funktionen adressieren über die öffentliche `loc_id` und scopen auf
// (book_id, user_email); die INTEGER-PK verlässt das Modul nur als Rückgabe für den
// FTS-Index.

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');
const { LOC_MANUAL_FIELDS, KI_COL, manualFieldSet, serializeManualFields } = require('./location-fields');

const LIMITS = { name: 200, typ: 40, stimmung: 200, beschreibung: 4000 };

class LocationEditError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}

function _row(bookId, userEmail, locId) {
  if (locId == null || locId === '') return null;
  return db.prepare(
    `SELECT id, loc_id, name, typ, beschreibung, stimmung, land, parent_id, stale, manually_created,
            manually_edited, manual_fields, ki_name, ki_typ, ki_beschreibung, ki_stimmung, ki_land
       FROM locations WHERE book_id = ? AND user_email IS ? AND loc_id = ?`
  ).get(bookId, userEmail || null, String(locId)) || null;
}

function _text(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > max) throw new LocationEditError('FIELD_TOO_LONG');
  return s;
}

// Normalisiert die editierbaren Felder. Nur übergebene Schlüssel werden geliefert,
// damit ein PATCH ohne `land` das Land nicht leert.
function _fields(input) {
  const out = {};
  if ('name' in input) {
    out.name = _text(input.name, LIMITS.name);
    if (!out.name) throw new LocationEditError('NAME_REQUIRED');
  }
  if ('typ' in input) out.typ = _text(input.typ, LIMITS.typ);
  if ('stimmung' in input) out.stimmung = _text(input.stimmung, LIMITS.stimmung);
  if ('beschreibung' in input) out.beschreibung = _text(input.beschreibung, LIMITS.beschreibung);
  if ('land' in input) {
    const l = _text(input.land, LIMITS.name);
    if (l && !/^[A-Za-z]{2}$/.test(l)) throw new LocationEditError('INVALID_LAND');
    out.land = l ? l.toLowerCase() : null;
  }
  return out;
}

// Elternort auflösen und Zyklen verhindern: der neue Elternort darf weder der Ort
// selbst noch einer seiner Nachfahren sein (sonst hinge der Teilbaum frei in der Luft
// und jede Baum-Darstellung liefe endlos).
function _resolveParent(bookId, userEmail, parentLocId, selfId) {
  if (parentLocId == null || parentLocId === '') return null;
  const p = _row(bookId, userEmail, parentLocId);
  if (!p) throw new LocationEditError('PARENT_NOT_FOUND', 404);
  if (selfId != null) {
    const seen = new Set();
    for (let cur = p; cur; cur = cur.parent_id ? db.prepare('SELECT id, parent_id FROM locations WHERE id = ?').get(cur.parent_id) : null) {
      if (cur.id === selfId) throw new LocationEditError('PARENT_CYCLE', 409);
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
    }
  }
  return p.id;
}

function createLocation(bookId, userEmail, input) {
  const f = _fields({ name: input?.name, ...input });
  const parentId = _resolveParent(bookId, userEmail, input?.parent, null);
  const sort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM locations WHERE book_id = ? AND user_email IS ?')
    .get(bookId, userEmail || null).n;
  return db.transaction(() => {
    // loc_id: 'man_<id>' liegt ausserhalb des 'ort_N'-Namespaces der Analyse. Die
    // PK kennen wir erst nach dem Insert, darum erst ein eindeutiger Platzhalter.
    const { lastInsertRowid: id } = db.prepare(`
      INSERT INTO locations (book_id, loc_id, name, typ, beschreibung, stimmung, land, parent_id, sort_order,
        user_email, manually_created, manually_edited, manual_fields, stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, 0, ${NOW_ISO_SQL})
    `).run(bookId, 'new_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), f.name,
      f.typ ?? null, f.beschreibung ?? null, f.stimmung ?? null, f.land ?? null, parentId, sort, userEmail || null,
      serializeManualFields(new Set(LOC_MANUAL_FIELDS)));
    const locId = 'man_' + id;
    db.prepare('UPDATE locations SET loc_id = ? WHERE id = ?').run(locId, id);
    return { id: Number(id), locId };
  })();
}

// Stammdaten korrigieren. Nur tatsächlich geänderte Felder landen im UPDATE und in
// `manual_fields` — ein Request, der nur den Elternort setzt oder unveränderte Werte
// mitschickt, schützt nichts vor der Analyse. Wird ein Feld zum ersten Mal geschützt
// und fehlt sein Analysewert noch (Altbestand), sichert der aktuelle Wert ihn — das
// ist bis dahin der Analysewert (Muster db/figures/patch.js).
function updateLocation(bookId, userEmail, locId, input) {
  const row = _row(bookId, userEmail, locId);
  if (!row) throw new LocationEditError('NOT_FOUND', 404);
  const f = _fields(input || {});
  const manual = manualFieldSet(row);
  const cols = {};
  for (const [k, v] of Object.entries(f)) {
    if ((row[k] ?? null) === v) continue;
    cols[k] = v;
    if (!manual.has(k)) {
      if (!row.manually_created && row[KI_COL[k]] == null) cols[KI_COL[k]] = row[k];
      manual.add(k);
    }
  }
  if (input && 'parent' in input) {
    const parentId = _resolveParent(bookId, userEmail, input.parent, row.id);
    if (parentId !== row.parent_id) cols.parent_id = parentId;
  }
  if (!Object.keys(cols).length) return { id: row.id, locId: row.loc_id, changed: false };
  const sets = Object.keys(cols).map(k => `${k} = ?`);
  const vals = Object.values(cols);
  // Neuer Name = neues Toponym: der Geocode-Resolve-Cache gilt nicht mehr (die
  // Koordinaten bleiben — der Autor hat den Pin bewusst gesetzt).
  if ('name' in cols) sets.push('geo_query = NULL', 'geo_land = NULL');
  const mf = serializeManualFields(manual);
  sets.push('manual_fields = ?', 'manually_edited = ?');
  vals.push(mf, mf ? 1 : 0);
  db.prepare(`UPDATE locations SET ${sets.join(', ')}, updated_at = ${NOW_ISO_SQL} WHERE id = ?`).run(...vals, row.id);
  return { id: row.id, locId: row.loc_id, changed: true };
}

// «Analyse-Werte übernehmen»: hebt den Schutz der Felder auf (alle oder `fields`) und
// setzt sie sofort auf den letzten Analysewert, wo einer bekannt ist. Ohne bekannten
// Wert bleibt der aktuelle stehen, bis der nächste Lauf ihn liefert. Ein nie von der
// Analyse gefundener Ort (selbst angelegt, ohne ki_name) hat nichts zum Übernehmen.
function restoreLocationAnalysis(bookId, userEmail, locId, fields = null) {
  const row = _row(bookId, userEmail, locId);
  if (!row) throw new LocationEditError('NOT_FOUND', 404);
  if (row.manually_created && row.ki_name == null) throw new LocationEditError('NO_ANALYSIS', 409);
  const manual = manualFieldSet(row);
  const wanted = Array.isArray(fields) ? fields.filter(x => manual.has(x)) : [...manual];
  const cols = {};
  const restored = [];
  for (const k of wanted) {
    manual.delete(k);
    const ki = row[KI_COL[k]];
    if (ki != null && ki !== row[k]) { cols[k] = ki; restored.push(k); }
  }
  if (!wanted.length) return { id: row.id, changed: false, restored, unprotected: [] };
  const sets = Object.keys(cols).map(k => `${k} = ?`);
  const vals = Object.values(cols);
  if ('name' in cols) sets.push('geo_query = NULL', 'geo_land = NULL');
  const mf = serializeManualFields(manual);
  sets.push('manual_fields = ?', 'manually_edited = ?');
  vals.push(mf, mf ? 1 : 0);
  db.prepare(`UPDATE locations SET ${sets.join(', ')}, updated_at = ${NOW_ISO_SQL} WHERE id = ?`).run(...vals, row.id);
  return { id: row.id, changed: true, restored, unprotected: wanted };
}

// Löschen ist nur für verwaiste («nicht mehr im Text») und vom Autor angelegte Orte
// erlaubt. Ein aktiver Analyse-Ort käme mit dem nächsten Lauf ohnehin zurück — für
// Dubletten ist das Zusammenführen der richtige Weg. CASCADE räumt die Brücken,
// Kinder fallen per SET NULL auf die Wurzel zurück.
function deleteLocation(bookId, userEmail, locId) {
  const row = _row(bookId, userEmail, locId);
  if (!row) throw new LocationEditError('NOT_FOUND', 404);
  if (!row.stale && !row.manually_created) throw new LocationEditError('NOT_DELETABLE', 409);
  db.prepare('DELETE FROM locations WHERE id = ?').run(row.id);
  return row.id;
}

function deleteStaleLocations(bookId, userEmail) {
  const ids = db.prepare('SELECT id FROM locations WHERE book_id = ? AND user_email IS ? AND stale = 1')
    .all(bookId, userEmail || null).map(r => r.id);
  db.transaction(() => {
    const del = db.prepare('DELETE FROM locations WHERE id = ?');
    for (const id of ids) del.run(id);
  })();
  return ids;
}

// loc_id → { id, stale } im Buch-/Konto-Scope (Merge-Route); null = nicht gefunden.
function locationRef(bookId, userEmail, locId) {
  const r = _row(bookId, userEmail, locId);
  return r ? { id: r.id, stale: !!r.stale } : null;
}

module.exports = {
  createLocation, updateLocation, restoreLocationAnalysis, deleteLocation, deleteStaleLocations, locationRef,
  LocationEditError,
};
