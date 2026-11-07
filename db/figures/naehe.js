'use strict';
// Lese-/Schreibkern des Jobs `figuren-naehe` (routes/jobs/figuren-naehe.js):
// Beziehungen eines Buchs samt Figurennamen und Rolle als Grundlage der
// Einschätzung, und das Zurückschreiben der Nähe. Schreibt NUR
// `figure_relations.naehe` — Typ, Beschreibung und `origin` bleiben, damit die
// nächste Komplettanalyse die Beziehung weiter als ihre eigene erkennt.

const { db } = require('../connection');
const { activeFigureSql } = require('./active');
const { normNaehe } = require('../../lib/relation-naehe');

/** @param {{ nurOffen?: boolean }} [opts] nurOffen: nur Beziehungen ohne Nähe. */
function listRelationsForNaehe(bookId, userEmail, { nurOffen = true } = {}) {
  return db.prepare(`
    SELECT r.id, r.typ, r.beschreibung, r.machtverhaltnis, r.naehe,
           ff.name AS from_name, ff.rolle AS from_rolle,
           ft.name AS to_name,   ft.rolle AS to_rolle
      FROM figure_relations r
      JOIN figures ff ON ff.id = r.from_fig_id
      JOIN figures ft ON ft.id = r.to_fig_id
     WHERE r.book_id = ? AND r.user_email IS ?
       AND ${activeFigureSql('ff')} AND ${activeFigureSql('ft')}
       ${nurOffen ? 'AND r.naehe IS NULL' : ''}
     ORDER BY r.id`).all(bookId, userEmail || null);
}

/** @param {Array<{ id: number, naehe: number }>} rows — id aus listRelationsForNaehe. */
function setRelationNaehe(bookId, userEmail, rows) {
  const upd = db.prepare('UPDATE figure_relations SET naehe = ? WHERE id = ? AND book_id = ? AND user_email IS ?');
  let n = 0;
  db.transaction(() => {
    for (const r of rows) {
      const v = normNaehe(r.naehe);
      if (v == null) continue;
      n += upd.run(v, r.id, bookId, userEmail || null).changes;
    }
  })();
  return n;
}

module.exports = { listRelationsForNaehe, setRelationNaehe };
