'use strict';
// Schulweg je Figur (`figure_school_paths`, Migration 345; docs/figur-lebenslauf.md
// «Schullaufbahn»). Eine Zeile pro Figur (figures.id).
//
// ZWEI SCHREIBER, GETRENNTE SPALTEN: der Autor (Route) setzt weg/einschulung_jahr/
// repetitionen_json + source; der Job `schulweg-vorschlag` setzt ausschliesslich
// vorschlag_json und klassenangaben_json. Ein Vorschlag ueberschreibt nie, was der Autor gesetzt hat —
// erst «Übernehmen» (Route) kopiert ihn in die Felder.
//
// Figuren sind pro (Buch, User): jeder Zugriff geht ueber (book_id, user_email,
// fig_id) bzw. die daraus aufgeloeste figures.id.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
require('./migrations');

const _parse = (s, fallback) => {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

function _row(r) {
  if (!r) return null;
  return {
    figure_id: r.figure_id,
    fig_id: r.fig_id,
    weg: r.weg || null,
    einschulung_jahr: r.einschulung_jahr ?? null,
    repetitionen: _parse(r.repetitionen_json, []),
    source: r.source || null,
    vorschlag: _parse(r.vorschlag_json, null),
    klassenangaben: _parse(r.klassenangaben_json, []),
    updated_at: r.updated_at || null,
  };
}

const _list = db.prepare(`
  SELECT sp.*, f.fig_id
  FROM figure_school_paths sp
  JOIN figures f ON f.id = sp.figure_id
  WHERE f.book_id = ? AND f.user_email IS ?
`);
/** Alle Schulwege der Figuren eines Users in einem Buch, nach figure_id. */
function listSchoolPaths(bookId, userEmail) {
  return _list.all(bookId, userEmail || null).map(_row);
}

const _get = db.prepare(`
  SELECT sp.*, f.fig_id FROM figure_school_paths sp JOIN figures f ON f.id = sp.figure_id
  WHERE sp.figure_id = ?
`);
function getSchoolPath(figureId) {
  return _row(_get.get(figureId));
}

const _figByFigId = db.prepare(`
  SELECT id, fig_id, name, geburtstag FROM figures WHERE book_id = ? AND fig_id = ? AND user_email IS ?
`);
/** figures-Zeile zur Katalog-Kennung (fig_id) — Scope Buch + User. */
function findFigureForSchoolPath(bookId, figId, userEmail) {
  return _figByFigId.get(bookId, String(figId), userEmail || null) || null;
}

const _listFigs = db.prepare(`
  SELECT f.id, f.fig_id, f.name, f.kurzname, f.geburtstag,
         sp.source, sp.weg, sp.einschulung_jahr, sp.repetitionen_json
  FROM figures f
  LEFT JOIN figure_school_paths sp ON sp.figure_id = f.id
  WHERE f.book_id = ? AND f.user_email IS ? AND f.stale = 0
  ORDER BY f.sort_order, f.id
`);
/** Aktive Figuren eines Users im Buch samt ihrem Schulweg (Job). */
function listFiguresForSchoolPath(bookId, userEmail) {
  return _listFigs.all(bookId, userEmail || null);
}

const _upsertAutor = db.prepare(`
  INSERT INTO figure_school_paths (figure_id, weg, einschulung_jahr, repetitionen_json, source, updated_at)
  VALUES (?, ?, ?, ?, ?, ${NOW_ISO_SQL})
  ON CONFLICT(figure_id) DO UPDATE SET
    weg = excluded.weg,
    einschulung_jahr = excluded.einschulung_jahr,
    repetitionen_json = excluded.repetitionen_json,
    source = excluded.source,
    updated_at = excluded.updated_at
`);
/** Felder setzen (Autor oder übernommener Vorschlag). Alles leer → source NULL. */
function setSchoolPath(figureId, { weg = null, einschulung_jahr = null, repetitionen = [] } = {}, source = 'autor') {
  const reps = Array.isArray(repetitionen) && repetitionen.length ? JSON.stringify(repetitionen) : null;
  const empty = weg == null && einschulung_jahr == null && !reps;
  _upsertAutor.run(figureId, weg, einschulung_jahr, reps, empty ? null : source);
  return getSchoolPath(figureId);
}

const _upsertJob = db.prepare(`
  INSERT INTO figure_school_paths (figure_id, vorschlag_json, klassenangaben_json, updated_at)
  VALUES (?, ?, ?, ${NOW_ISO_SQL})
  ON CONFLICT(figure_id) DO UPDATE SET
    vorschlag_json = excluded.vorschlag_json,
    klassenangaben_json = excluded.klassenangaben_json,
    updated_at = excluded.updated_at
`);
// Leeren ohne Zeile anzulegen: eine Leerzeile sähe für den Figuren-Merge wie ein
// Schulweg des Ziels aus.
const _clearJob = db.prepare(`
  UPDATE figure_school_paths SET vorschlag_json = NULL, klassenangaben_json = NULL, updated_at = ${NOW_ISO_SQL}
  WHERE figure_id = ? AND (vorschlag_json IS NOT NULL OR klassenangaben_json IS NOT NULL)
`);
/** Ergebnis eines Job-Laufs ablegen: Vorschlag und Klassenangaben ersetzen den
 *  Stand des letzten Laufs. Berührt die Autor-Felder nie. */
function setSchoolPathJobErgebnis(figureId, { vorschlag = null, klassenangaben = [] } = {}) {
  const ka = Array.isArray(klassenangaben) && klassenangaben.length ? JSON.stringify(klassenangaben) : null;
  if (!vorschlag && !ka) { _clearJob.run(figureId); return; }
  _upsertJob.run(figureId, vorschlag ? JSON.stringify(vorschlag) : null, ka);
}

const _setVorschlag = db.prepare(`
  UPDATE figure_school_paths SET vorschlag_json = ?, updated_at = ${NOW_ISO_SQL} WHERE figure_id = ?
`);
/** Offenen KI-Vorschlag verwerfen bzw. nach dem Übernehmen leeren (null). Legt nie
 *  eine Zeile an; Vorschläge schreibt nur der Job (setSchoolPathJobErgebnis). */
function clearSchoolPathVorschlag(figureId) {
  _setVorschlag.run(null, figureId);
}

module.exports = {
  listSchoolPaths,
  getSchoolPath,
  findFigureForSchoolPath,
  listFiguresForSchoolPath,
  setSchoolPath,
  setSchoolPathJobErgebnis,
  clearSchoolPathVorschlag,
};
