'use strict';
// Berufsweg und Hobbys der Figuren (`figure_jobs`, `figure_hobbies`, Migration 356;
// docs/figur-lebenslauf.md «Berufsweg und Hobbys»). Zwei Listen, eine Mechanik:
// `kind` wählt die Tabelle und das Pflichtfeld (Tätigkeit bzw. Hobby).
//
// ZWEI SCHREIBER, GETRENNTE ZEILEN: der Autor (Route) legt Zeilen mit status
// 'aktiv' an; der Job `stationen-vorschlag` schreibt ausschliesslich Zeilen mit
// status 'vorschlag' und ersetzt nur diese. Erst «Übernehmen» macht aus einem
// Vorschlag eine aktive Zeile (source 'ki').
//
// Figuren sind pro (Buch, User): Lesen geht über (book_id, user_email), Schreiben
// über die aufgelöste figures.id — jede Zeilen-Operation prüft zusätzlich, dass
// die Zeile zu dieser Figur gehört.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
require('./migrations');

const KINDS = {
  berufe: { table: 'figure_jobs', main: 'taetigkeit', extra: ['art', 'arbeitgeber', 'ort'] },
  hobbys: { table: 'figure_hobbies', main: 'hobby', extra: ['ort'] },
};
const STATION_KINDS = Object.keys(KINDS);
const JOB_ARTEN = ['ausbildung', 'beruf'];
const COMMON = ['von_jahr', 'von_monat', 'bis_jahr', 'bis_monat', 'notiz', 'zitat', 'page_id', 'begruendung'];

function _cfg(kind) {
  const c = KINDS[kind];
  if (!c) throw new Error(`unbekannte Stationsart: ${kind}`);
  return c;
}

function _fieldsOf(kind) {
  const c = _cfg(kind);
  return [c.main, ...c.extra, ...COMMON];
}

function _row(kind, r) {
  if (!r) return null;
  const out = { id: r.id, kind, fig_id: r.fig_id ?? undefined, status: r.status, source: r.source };
  for (const f of _fieldsOf(kind)) out[f] = r[f] ?? null;
  out.page_name = r.page_name ?? null;
  out.updated_at = r.updated_at || null;
  return out;
}

const _stmts = {};
function _st(kind, key, sqlFn) {
  const k = `${kind}:${key}`;
  if (!_stmts[k]) _stmts[k] = db.prepare(sqlFn(_cfg(kind)));
  return _stmts[k];
}

// Sortierung: datierte zuerst nach Beginn, dann undatierte; Vorschläge hinter
// den aktiven. Gleiche Reihenfolge in Steckbrief, Buch-Chat und Stichtag-Spalte.
const _ORDER = `ORDER BY s.status = 'vorschlag', s.von_jahr IS NULL, s.von_jahr, s.von_monat, s.bis_jahr IS NULL, s.bis_jahr, s.id`;

/** Alle Stationen einer Art für die Figuren eines Users im Buch (aktive Figuren). */
function listStationen(kind, bookId, userEmail) {
  return _st(kind, 'list', c => `
    SELECT s.*, f.fig_id, p.page_name FROM ${c.table} s
    JOIN figures f ON f.id = s.figure_id
    LEFT JOIN pages p ON p.page_id = s.page_id
    WHERE f.book_id = ? AND f.user_email IS ? AND f.stale = 0
    ${_ORDER}
  `).all(bookId, userEmail || null).map(r => _row(kind, r));
}

/** Stationen einer Figur (figures.id), optional nur aktive. */
function listStationenForFigure(kind, figureId, { nurAktiv = false } = {}) {
  return _st(kind, nurAktiv ? 'figAktiv' : 'fig', c => `
    SELECT s.*, f.fig_id, p.page_name FROM ${c.table} s
    JOIN figures f ON f.id = s.figure_id
    LEFT JOIN pages p ON p.page_id = s.page_id
    WHERE s.figure_id = ?${nurAktiv ? " AND s.status = 'aktiv'" : ''}
    ${_ORDER}
  `).all(figureId).map(r => _row(kind, r));
}

function getStation(kind, id, figureId) {
  return _row(kind, _st(kind, 'get', c => `
    SELECT s.*, f.fig_id, p.page_name FROM ${c.table} s
    JOIN figures f ON f.id = s.figure_id
    LEFT JOIN pages p ON p.page_id = s.page_id
    WHERE s.id = ? AND s.figure_id = ?
  `).get(id, figureId));
}

function _values(kind, fields) {
  // `art` ist NOT NULL mit Default: ein fehlender Wert heisst «beruf», nicht NULL.
  return _fieldsOf(kind).map(f => (f === 'art' ? (JOB_ARTEN.includes(fields.art) ? fields.art : 'beruf')
    : fields[f] === undefined ? null : fields[f]));
}

/** Neue Zeile. status 'aktiv' (Autor) oder 'vorschlag' (Job). */
function createStation(kind, figureId, fields, { status = 'aktiv', source = 'autor' } = {}) {
  const cols = _fieldsOf(kind);
  const info = _st(kind, 'insert', c => `
    INSERT INTO ${c.table} (figure_id, status, source, ${cols.join(', ')}, created_at, updated_at)
    VALUES (?, ?, ?, ${cols.map(() => '?').join(', ')}, ${NOW_ISO_SQL}, ${NOW_ISO_SQL})
  `).run(figureId, status, source, ..._values(kind, fields));
  return getStation(kind, info.lastInsertRowid, figureId);
}

/** Autor ändert eine aktive Zeile. Beleg (zitat/page_id/begruendung) bleibt stehen. */
function updateStation(kind, id, figureId, fields) {
  const cols = _fieldsOf(kind).filter(f => !['zitat', 'page_id', 'begruendung'].includes(f));
  const info = _st(kind, 'update', c => `
    UPDATE ${c.table} SET ${cols.map(f => `${f} = ?`).join(', ')}, updated_at = ${NOW_ISO_SQL}
    WHERE id = ? AND figure_id = ? AND status = 'aktiv'
  `).run(...cols.map(f => (f === 'art' ? (JOB_ARTEN.includes(fields.art) ? fields.art : 'beruf')
    : fields[f] === undefined ? null : fields[f])), id, figureId);
  return info.changes ? getStation(kind, id, figureId) : null;
}

/** Löschen (aktive Zeile) bzw. Verwerfen (Vorschlag). */
function deleteStation(kind, id, figureId) {
  return _st(kind, 'delete', c => `DELETE FROM ${c.table} WHERE id = ? AND figure_id = ?`)
    .run(id, figureId).changes > 0;
}

/** Vorschlag übernehmen: wird aktive Zeile mit source 'ki'. */
function acceptStation(kind, id, figureId) {
  const info = _st(kind, 'accept', c => `
    UPDATE ${c.table} SET status = 'aktiv', source = 'ki', updated_at = ${NOW_ISO_SQL}
    WHERE id = ? AND figure_id = ? AND status = 'vorschlag'
  `).run(id, figureId);
  return info.changes ? getStation(kind, id, figureId) : null;
}

/** Job-Ergebnis einer Figur: ersetzt ihre offenen Vorschläge dieser Art, fasst
 *  aktive Zeilen nie an. Eine Transaktion pro Figur und Art. */
const replaceVorschlaege = db.transaction((kind, figureId, rows) => {
  _st(kind, 'clearVorschlag', c => `DELETE FROM ${c.table} WHERE figure_id = ? AND status = 'vorschlag'`).run(figureId);
  for (const r of rows || []) createStation(kind, figureId, r, { status: 'vorschlag', source: 'ki' });
});

module.exports = {
  STATION_KINDS, JOB_ARTEN, KINDS,
  listStationen, listStationenForFigure, getStation,
  createStation, updateStation, deleteStation, acceptStation, replaceVorschlaege,
};
