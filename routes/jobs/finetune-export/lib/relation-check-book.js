'use strict';

// Beziehungsprüfung eines Buchs ohne Buchtext (relation-check.js) — für die
// Figuren-Karte (GET /figures/:book_id/relation-check) und das Log am Ende der
// Komplettanalyse. Lädt nur, was die Prüfung liest: aktive Figuren mit Namen,
// Geschlecht, Typ und Biografie, ihre Beziehungen und Lebensereignisse.
// Korrigiert wird nichts.

const { db } = require('../../../../db/schema');
const { relationTypes } = require('../../../../lib/esm-bridge');
const { checkRelations } = require('./relation-check');
const { nameInfo } = require('../samples/core-facts/naming');
const { figureTier } = require('../samples/core-facts/words');

function loadRelationCheckCtx(bookId, userEmail) {
  // stale = 0 wie im Export: eine nicht wiedergefundene Figur ist oft die alte
  // Dublette einer umbenannten und meldete sonst Scheinkonflikte.
  const figRows = db.prepare(`
    SELECT fig_id, id AS pk, name, kurzname, typ, geschlecht, geburtstag, beschreibung, hintergrund
    FROM figures
    WHERE book_id = ? AND user_email IS ? AND stale = 0
    ORDER BY sort_order
  `).all(bookId, userEmail);
  const figById = new Map(figRows.map(f => [f.fig_id, f]));
  const eventsByFigPk = new Map();
  for (const r of db.prepare(`
    SELECT fe.id, fe.figure_id, fe.ereignis, fe.bedeutung, fe.subtyp, fe.datum_year, fe.datum_unsicher
    FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    WHERE f.book_id = ? AND f.user_email IS ? AND f.stale = 0
    ORDER BY fe.sort_order
  `).all(bookId, userEmail)) {
    if (!eventsByFigPk.has(r.figure_id)) eventsByFigPk.set(r.figure_id, []);
    eventsByFigPk.get(r.figure_id).push(r);
  }
  const figRelRows = db.prepare(`
    SELECT r.id AS rel_id, ff.fig_id AS from_fig_id, ft.fig_id AS to_fig_id, r.typ, r.beschreibung
    FROM figure_relations r
    JOIN figures ff ON ff.id = r.from_fig_id
    JOIN figures ft ON ft.id = r.to_fig_id
    WHERE r.book_id = ? AND r.user_email IS ?
  `).all(bookId, userEmail);
  return {
    figRows, figById, eventsByFigPk, figRelRows,
    figNameInfo: nameInfo(figRows),
    tierByFig: new Map(figRows.map(f => [f.fig_id, figureTier(f.typ)])),
  };
}

// → { conflicts, mainCount, edges }
//   `conflicts` ohne die internen Sperr-Paare; `edges` löst jede Quelle
//   `relation:<id>` auf ihre Kante auf ({ id, from, to, typ }, fig_id), damit
//   die Karte die betroffenen Beziehungen bei der Figur markieren kann.
async function runBookRelationCheck(bookId, userEmail) {
  const ctx = loadRelationCheckCtx(bookId, userEmail || null);
  ctx.relTypes = await relationTypes();
  const { conflicts, mainCount } = checkRelations(ctx);
  const relIds = new Set(conflicts.flatMap(c => c.sources)
    .filter(s => s.startsWith('relation:')).map(s => Number(s.slice('relation:'.length))));
  const edges = ctx.figRelRows.filter(r => relIds.has(r.rel_id))
    .map(r => ({ id: r.rel_id, from: r.from_fig_id, to: r.to_fig_id, typ: r.typ }));
  return { conflicts: conflicts.map(({ pairs, ...c }) => c), mainCount, edges };
}

module.exports = { runBookRelationCheck, loadRelationCheckCtx };
