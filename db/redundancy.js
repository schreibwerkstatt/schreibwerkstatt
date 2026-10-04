'use strict';
// Redundanz-Radar (docs/redundanz.md): letztes Ergebnis pro (Buch, User) und
// die Paare, die der User als „gewollt, kein Befund" ignoriert.
//
// `redundancy_runs` ist reine Ableitung (CASCADE mit Buch und Konto): das
// Ergebnis des letzten Laufs, damit die Karte beim Öffnen nicht leer steht.
// Seiten-/Figurennamen stehen bewusst NICHT darin — das Frontend löst sie zur
// Lesezeit auf; Seiten, die seither gelöscht oder verschoben wurden, blendet es
// aus.
//
// `redundancy_dismissals` ist user-kuratiert, aber ohne beide Anker sinnlos
// (CASCADE auf Seite/Figur): ein Paar steht immer normiert mit a < b.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { requireUserEmail } = require('./write-helpers');
require('./migrations');

const KINDS = new Set(['page', 'figure']);

const _selRun = db.prepare(
  'SELECT threshold, result_json, created_at FROM redundancy_runs WHERE book_id = ? AND user_email = ?'
);
const _upsertRun = db.prepare(`
  INSERT INTO redundancy_runs (book_id, user_email, threshold, result_json, created_at)
  VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})
  ON CONFLICT(book_id, user_email) DO UPDATE SET
    threshold = excluded.threshold, result_json = excluded.result_json, created_at = excluded.created_at
`);
const _selDismissals = db.prepare(`
  SELECT kind, COALESCE(page_a_id, figure_a_id) AS a_id, COALESCE(page_b_id, figure_b_id) AS b_id
    FROM redundancy_dismissals WHERE book_id = ? AND user_email = ?
`);
const _insPage = db.prepare(`
  INSERT OR IGNORE INTO redundancy_dismissals (book_id, user_email, kind, page_a_id, page_b_id, created_at)
  VALUES (?, ?, 'page', ?, ?, ${NOW_ISO_SQL})
`);
const _insFigure = db.prepare(`
  INSERT OR IGNORE INTO redundancy_dismissals (book_id, user_email, kind, figure_a_id, figure_b_id, created_at)
  VALUES (?, ?, 'figure', ?, ?, ${NOW_ISO_SQL})
`);
const _delPage = db.prepare(
  "DELETE FROM redundancy_dismissals WHERE book_id = ? AND user_email = ? AND kind = 'page' AND page_a_id = ? AND page_b_id = ?"
);
const _delFigure = db.prepare(
  "DELETE FROM redundancy_dismissals WHERE book_id = ? AND user_email = ? AND kind = 'figure' AND figure_a_id = ? AND figure_b_id = ?"
);
const _delAll = db.prepare('DELETE FROM redundancy_dismissals WHERE book_id = ? AND user_email = ?');
// Anker-Prüfung: beide Seiten im Buch bzw. beide Figuren im Buch UND dem User
// gehörend. Reiner Lesezugriff im eigenen db/-Modul (Content-Store-Regel).
const _cntPages = db.prepare('SELECT COUNT(*) AS n FROM pages WHERE page_id IN (?, ?) AND book_id = ?');
const _cntFigures = db.prepare('SELECT COUNT(*) AS n FROM figures WHERE id IN (?, ?) AND book_id = ? AND user_email = ?');

function getLastRun(bookId, userEmail) {
  const row = _selRun.get(bookId, userEmail);
  if (!row) return null;
  try {
    return { ...JSON.parse(row.result_json), threshold: row.threshold, createdAt: row.created_at };
  } catch {
    return null;
  }
}

function saveRun(bookId, userEmail, threshold, result) {
  const email = requireUserEmail(userEmail, 'redundancy.saveRun');
  _upsertRun.run(bookId, email, threshold, JSON.stringify(result));
}

// Paar normieren (a < b). null = ungültige Eingabe.
function _norm(kind, a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!KINDS.has(kind) || !Number.isInteger(x) || !Number.isInteger(y) || x <= 0 || y <= 0 || x === y) return null;
  return x < y ? [x, y] : [y, x];
}

// { page:Set<'a:b'>, figure:Set<'a:b'> } — Lookup für den Job-Filter.
function dismissalSets(bookId, userEmail) {
  const out = { page: new Set(), figure: new Set() };
  for (const r of _selDismissals.all(bookId, userEmail)) out[r.kind].add(r.a_id + ':' + r.b_id);
  return out;
}

function countDismissals(bookId, userEmail) {
  return _selDismissals.all(bookId, userEmail).length;
}

// true = gespeichert (oder schon vorhanden); false = Paar gehört nicht zu Buch/User.
function addDismissal(bookId, userEmail, kind, a, b) {
  const email = requireUserEmail(userEmail, 'redundancy.addDismissal');
  const pair = _norm(kind, a, b);
  if (!pair) return false;
  if (kind === 'page') {
    if (_cntPages.get(pair[0], pair[1], bookId).n !== 2) return false;
    _insPage.run(bookId, email, pair[0], pair[1]);
  } else {
    if (_cntFigures.get(pair[0], pair[1], bookId, email).n !== 2) return false;
    _insFigure.run(bookId, email, pair[0], pair[1]);
  }
  return true;
}

function removeDismissal(bookId, userEmail, kind, a, b) {
  const pair = _norm(kind, a, b);
  if (!pair) return 0;
  const stmt = kind === 'page' ? _delPage : _delFigure;
  return stmt.run(bookId, userEmail, pair[0], pair[1]).changes;
}

function clearDismissals(bookId, userEmail) {
  return _delAll.run(bookId, userEmail).changes;
}

module.exports = {
  getLastRun, saveRun, dismissalSets, countDismissals, addDismissal, removeDismissal, clearDismissals,
};
