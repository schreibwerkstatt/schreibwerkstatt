'use strict';

// Autor-Daten an Figuren in der Buch-Migration (.swbook, Analyse-Block):
// Schulweg (`figure_school_paths`) sowie Berufsweg und Hobbys (`figure_jobs`,
// `figure_hobbies`). Ausgelagert aus db/book-migration-data.js (Facade), das sie
// im Analyse-Block sammelt und nach den Figuren einspielt.
//
// Offene Vorschläge und Klassenangaben reisen mit — sie tragen ihren Beleg
// selbst; dessen page_id wird wie jede andere umgeschlüsselt.

const { db } = require('../connection');

function _now() { return new Date().toISOString(); }

const FIGURE_EXTRA_QUERIES = {
  figureSchoolPaths: 'SELECT fsp.* FROM figure_school_paths fsp JOIN figures f ON f.id = fsp.figure_id WHERE f.book_id = ? AND f.user_email IS ?',
  figureJobs:        'SELECT s.* FROM figure_jobs s JOIN figures f ON f.id = s.figure_id WHERE f.book_id = ? AND f.user_email IS ?',
  figureHobbies:     'SELECT s.* FROM figure_hobbies s JOIN figures f ON f.id = s.figure_id WHERE f.book_id = ? AND f.user_email IS ?',
};

const _int = (v) => (Number.isInteger(v) ? v : null);
const _monat = (v) => (Number.isInteger(v) && v >= 1 && v <= 12 ? v : null);

function _restoreSchoolPaths(rows, figMap, pageOf) {
  const remapBelege = (json) => {
    if (!json) return null;
    let v;
    try { v = JSON.parse(json); } catch { return null; }
    const fix = (o) => (o && typeof o === 'object' ? { ...o, page_id: o.page_id != null ? (pageOf(o.page_id) ?? null) : null } : o);
    return JSON.stringify(Array.isArray(v) ? v.map(fix) : fix(v));
  };
  const ins = db.prepare(`INSERT OR IGNORE INTO figure_school_paths
    (figure_id,weg,einschulung_jahr,repetitionen_json,source,vorschlag_json,klassenangaben_json,updated_at) VALUES (?,?,?,?,?,?,?,?)`);
  for (const r of rows) {
    const fid = figMap.get(r.figure_id);
    if (!fid) continue;
    const source = r.source === 'autor' || r.source === 'ki' ? r.source : null;
    ins.run(fid, r.weg ?? null, _int(r.einschulung_jahr), r.repetitionen_json ?? null, source,
      remapBelege(r.vorschlag_json), remapBelege(r.klassenangaben_json), r.updated_at || _now());
  }
}

function _restoreStationen(table, main, extra, rows, figMap, pageOf) {
  const cols = [main, ...extra, 'von_jahr', 'von_monat', 'bis_jahr', 'bis_monat', 'notiz', 'zitat', 'page_id', 'begruendung'];
  const ins = db.prepare(`INSERT INTO ${table}
    (figure_id,status,source,${cols.join(',')},created_at,updated_at) VALUES (?,?,?,${cols.map(() => '?').join(',')},?,?)`);
  for (const r of rows) {
    const fid = figMap.get(r.figure_id);
    if (!fid || !r[main]) continue;
    const vals = cols.map((c) => {
      if (c === 'page_id') return r.page_id != null ? (pageOf(r.page_id) ?? null) : null;
      if (c === 'von_jahr' || c === 'bis_jahr') return _int(r[c]);
      if (c === 'von_monat' || c === 'bis_monat') return _monat(r[c]);
      if (c === 'art') return r.art === 'ausbildung' ? 'ausbildung' : 'beruf';
      return r[c] ?? null;
    });
    ins.run(fid, r.status === 'vorschlag' ? 'vorschlag' : 'aktiv', r.source === 'ki' ? 'ki' : 'autor',
      ...vals, r.created_at || _now(), r.updated_at || _now());
  }
}

/** Nach den Figuren aufrufen: `arr(key)` liefert die Bundle-Zeilen. */
function restoreFigureExtras(arr, { figMap, pageOf }) {
  _restoreSchoolPaths(arr('figureSchoolPaths'), figMap, pageOf);
  _restoreStationen('figure_jobs', 'taetigkeit', ['art', 'arbeitgeber', 'ort'], arr('figureJobs'), figMap, pageOf);
  _restoreStationen('figure_hobbies', 'hobby', ['ort'], arr('figureHobbies'), figMap, pageOf);
}

module.exports = { FIGURE_EXTRA_QUERIES, restoreFigureExtras };
