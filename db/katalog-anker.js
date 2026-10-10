'use strict';
// Lesepfad für den Katalog-Anker der Komplettanalyse: die Bestandsfiguren und
// -schauplätze eines Buchs/Users mit stabiler Zeilen-id, Namensvarianten und Typ.
// Der Job zeigt sie der Extraktion, damit das Modell sagt, welche Bestandszeile es
// meint (routes/jobs/komplett/katalog-anker.js).
const { db } = require('./connection');
require('./migrations');
const { listFigureAliasesByFigure } = require('./figures/aliases');

function listKatalogAnker(bookId, userEmail) {
  const em = userEmail || null;
  const figuren = db.prepare(`
    SELECT id, COALESCE(ki_name, name) AS ki_name, name, kurzname, typ, stale
      FROM figures WHERE book_id = ? AND user_email IS ?
     ORDER BY stale, sort_order, id`).all(bookId, em);
  const aliasesByFig = listFigureAliasesByFigure(bookId, em);
  for (const f of figuren) f.aliases = aliasesByFig.get(f.id) || [];
  const orte = db.prepare(`
    SELECT id, COALESCE(ki_name, name) AS ki_name, name, typ, stale
      FROM locations WHERE book_id = ? AND user_email IS ?
     ORDER BY stale, sort_order, id`).all(bookId, em);
  return { figuren, orte };
}

function countActiveLocations(bookId, userEmail) {
  return db.prepare('SELECT COUNT(*) AS c FROM locations WHERE book_id = ? AND user_email IS ? AND stale = 0')
    .get(bookId, userEmail || null).c;
}

module.exports = { listKatalogAnker, countActiveLocations };
