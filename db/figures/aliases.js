// Dauerhafte Namens-Aliasse einer Katalogfigur (`figure_aliases`, Migration 321).
//
// Ein Alias ist ein vom Autor bestaetigter Name, unter dem die Figur im Text
// ebenfalls steht — er entsteht beim manuellen Zusammenfuehren (Name/Kurzname der
// weggemergten Quelle, db/entity-merge.js). Gelesen wird er vom Cross-Run-
// Abgleich (save.js#planFigurenMatch → lib/entity-match.js#scoreFigurePair) und
// von der Namens-Aufloesung der Szenen/Ereignisse (buildFigNameLookup), damit die
// weggemergte Figur bei der naechsten Komplettanalyse nicht wiederkehrt.
//
// Gespeichert wird die Anzeigeform; verglichen wird ueber normName. Dubletten
// (gleiche Normalform wie Name, Kurzname oder ein vorhandener Alias der Figur)
// fallen schon beim Schreiben weg.

const { db } = require('../connection');
const { normName } = require('../../lib/name-normalize');
require('../migrations');

const MAX_ALIAS_LEN = 200;

/** Aliasse aller Figuren eines Buchs/Users: Map(figures.id → [alias]). */
function listFigureAliasesByFigure(bookId, userEmail) {
  const rows = db.prepare(`
    SELECT a.figure_id, a.alias FROM figure_aliases a
    JOIN figures f ON f.id = a.figure_id
    WHERE f.book_id = ? AND f.user_email IS ?
    ORDER BY a.id`).all(bookId, userEmail || null);
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.figure_id)) out.set(r.figure_id, []);
    out.get(r.figure_id).push(r.alias);
  }
  return out;
}

/** Haengt `names` als Aliasse an die Figur `figureId` (Buch `bookId`). Uebergeht
 *  leere Namen, Namen mit derselben Normalform wie Name/Kurzname der Figur und
 *  schon vorhandene Aliasse. Liefert die tatsaechlich angelegten Aliasse.
 *  Laeuft im Transaktions-Kontext des Aufrufers (Merge). */
function addFigureAliases(figureId, bookId, names) {
  const fig = db.prepare('SELECT name, kurzname FROM figures WHERE id = ? AND book_id = ?').get(figureId, bookId);
  if (!fig) return [];
  const seen = new Set([normName(fig.name), normName(fig.kurzname)].filter(Boolean));
  for (const r of db.prepare('SELECT alias FROM figure_aliases WHERE figure_id = ?').all(figureId)) {
    seen.add(normName(r.alias));
  }
  const ins = db.prepare('INSERT OR IGNORE INTO figure_aliases (figure_id, book_id, alias) VALUES (?, ?, ?)');
  const added = [];
  for (const raw of names || []) {
    const alias = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, MAX_ALIAS_LEN);
    const key = normName(alias);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (ins.run(figureId, bookId, alias).changes) added.push(alias);
  }
  return added;
}

module.exports = { listFigureAliasesByFigure, addFigureAliases };
