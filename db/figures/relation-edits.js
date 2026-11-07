'use strict';
// Korrekturen des Autors an einzelnen Figuren-Beziehungen: löschen und umhängen
// (Routen in routes/figures.js, Knöpfe an gemeldeten Kanten der Figuren-Karte).
//
// Verworfene KI-Kanten bekommen eine Löschmarke (`figure_relation_suppressions`,
// Migration 0358), damit der nächste Analyselauf sie nicht wieder anlegt; eine
// umgehängte Kante wird `origin = 'manual'` und sperrt damit ihr neues Paar für
// KI-Kanten (db/figures/save.js#_writeRelations).

const { db } = require('../connection');
require('../migrations');
const { NOW_ISO_SQL } = require('../now');
const { relationKey, RELATION_INVERSES } = require('./refs');

/** Kanonische Form wie relationKey: kleinere id vorn, gerichteter Typ beim
 *  Tauschen auf sein Inverses. */
function _canonical(from, to, typ) {
  return from < to ? { from, to, typ } : { from: to, to: from, typ: RELATION_INVERSES[typ] || typ };
}

function suppressRelation(bookId, em, fromId, toId, typ) {
  const c = _canonical(fromId, toId, typ);
  db.prepare(`INSERT OR IGNORE INTO figure_relation_suppressions
    (book_id, user_email, from_fig_id, to_fig_id, typ, created_at) VALUES (?, ?, ?, ?, ?, ${NOW_ISO_SQL})`)
    .run(bookId, em ?? null, c.from, c.to, c.typ);
}

/** relationKey-Menge der verworfenen KI-Kanten eines Buchs/Scopes (figures.id). */
function loadSuppressedRelationKeys(bookId, em) {
  return new Set(db.prepare(
    'SELECT from_fig_id, to_fig_id, typ FROM figure_relation_suppressions WHERE book_id = ? AND user_email IS ?'
  ).all(bookId, em ?? null).map(r => relationKey(r.from_fig_id, r.to_fig_id, r.typ)));
}

function _relRow(bookId, em, relId) {
  return db.prepare(
    'SELECT id, from_fig_id, to_fig_id, typ, origin FROM figure_relations WHERE id = ? AND book_id = ? AND user_email IS ?'
  ).get(relId, bookId, em ?? null) || null;
}

/** Löscht eine Beziehung; eine KI-Kante bekommt dabei ihre Löschmarke.
 *  false = keine solche Kante in diesem Buch/Scope. */
function deleteFigureRelation(bookId, em, relId) {
  return db.transaction(() => {
    const r = _relRow(bookId, em, relId);
    if (!r) return false;
    if (r.origin === 'ki') suppressRelation(bookId, em, r.from_fig_id, r.to_fig_id, r.typ);
    db.prepare('DELETE FROM figure_relations WHERE id = ?').run(r.id);
    return true;
  })();
}

/** Hängt das Ziel einer Beziehung auf eine andere Figur desselben Buchs/Scopes um
 *  (`toFigId` = figures.fig_id, die Kennung des Katalogs). Die Kante wird
 *  'manual'; war sie eine KI-Kante, wird die alte Fassung markiert. Besteht dieselbe
 *  Kante zum neuen Ziel schon, fällt die alte nur weg.
 *  → { ok: true } · { error: 'NOT_FOUND' | 'TARGET_NOT_FOUND' | 'SELF_RELATION' } */
function retargetFigureRelation(bookId, em, relId, toFigId) {
  return db.transaction(() => {
    const r = _relRow(bookId, em, relId);
    if (!r) return { error: 'NOT_FOUND' };
    const target = db.prepare('SELECT id FROM figures WHERE book_id = ? AND user_email IS ? AND fig_id = ?')
      .get(bookId, em ?? null, String(toFigId));
    if (!target) return { error: 'TARGET_NOT_FOUND' };
    if (target.id === r.from_fig_id) return { error: 'SELF_RELATION' };
    if (target.id === r.to_fig_id) return { ok: true };
    if (r.origin === 'ki') suppressRelation(bookId, em, r.from_fig_id, r.to_fig_id, r.typ);
    const moved = db.prepare(
      "UPDATE OR IGNORE figure_relations SET to_fig_id = ?, origin = 'manual' WHERE id = ?"
    ).run(target.id, r.id).changes;
    if (!moved) db.prepare('DELETE FROM figure_relations WHERE id = ?').run(r.id);
    return { ok: true };
  })();
}

module.exports = {
  suppressRelation, loadSuppressedRelationKeys, deleteFigureRelation, retargetFigureRelation,
};
