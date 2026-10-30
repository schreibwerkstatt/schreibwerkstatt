'use strict';
// Schulweg je Figur (`figure_school_paths`, Migration 345; docs/figur-lebenslauf.md
// «Schullaufbahn»). Eine Zeile pro Figur (figures.id).
//
// ZWEI SCHREIBER, GETRENNTE SPALTEN: der Autor (Route) setzt weg/einschulung_jahr/
// repetitionen_json + source; der Job `schulweg-vorschlag` setzt ausschliesslich
// vorschlag_json. Ein Vorschlag ueberschreibt nie, was der Autor gesetzt hat —
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
  SELECT f.id, f.fig_id, f.name, f.kurzname, f.geburtstag, sp.source
  FROM figures f
  LEFT JOIN figure_school_paths sp ON sp.figure_id = f.id
  WHERE f.book_id = ? AND f.user_email IS ? AND f.stale = 0
  ORDER BY f.sort_order, f.id
`);
/** Aktive Figuren eines Users im Buch samt Herkunft ihres Schulwegs (Job). */
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

const _setVorschlag = db.prepare(`
  INSERT INTO figure_school_paths (figure_id, vorschlag_json, updated_at)
  VALUES (?, ?, ${NOW_ISO_SQL})
  ON CONFLICT(figure_id) DO UPDATE SET
    vorschlag_json = excluded.vorschlag_json,
    updated_at = excluded.updated_at
`);
/** KI-Vorschlag ablegen bzw. mit null verwerfen. Berührt die Autor-Felder nie. */
function setSchoolPathVorschlag(figureId, vorschlag) {
  _setVorschlag.run(figureId, vorschlag ? JSON.stringify(vorschlag) : null);
}

module.exports = {
  listSchoolPaths,
  getSchoolPath,
  findFigureForSchoolPath,
  listFiguresForSchoolPath,
  setSchoolPath,
  setSchoolPathVorschlag,
};
