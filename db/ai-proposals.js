'use strict';
// Offene KI-Vorschläge (Tabelle `ai_proposals`, Migration 0364).
//
// Autorenprofil-Deutung und Buch-Stilprofil ersetzen den geltenden Text nie
// selbst — ihr Ergebnis ist ein Vorschlag, über den der Autor mit «Übernehmen»
// oder «Verwerfen» entscheidet. Der Job legt ihn hier ab, damit er einen Lauf
// überlebt, dessen Ende niemand gesehen hat (App zu, Server-Neustart, Job nach
// der Aufräumfrist aus dem Speicher). Je (kind, Konto, Buch) höchstens einer:
// ein neuer Lauf ersetzt den offenen Vorschlag.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const PROPOSAL_KINDS = new Set(['autorenprofil', 'stilprofil']);

function _check(kind, userEmail) {
  if (!PROPOSAL_KINDS.has(kind)) throw new Error(`ai_proposals: unbekannte Art ${kind}`);
  if (!userEmail) throw new Error('ai_proposals: user_email fehlt');
}

/** Offenen Vorschlag ablegen (ersetzt einen älteren derselben Stelle). */
function saveProposal(kind, userEmail, bookId, payload) {
  _check(kind, userEmail);
  db.transaction(() => {
    db.prepare('DELETE FROM ai_proposals WHERE kind = ? AND user_email = ? AND IFNULL(book_id, 0) = ?')
      .run(kind, userEmail, bookId || 0);
    db.prepare(`INSERT INTO ai_proposals (kind, user_email, book_id, payload_json, created_at)
                VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})`)
      .run(kind, userEmail, bookId || null, JSON.stringify(payload));
  })();
}

/** @returns {null | { payload: object, created_at: string }} */
function getProposal(kind, userEmail, bookId) {
  _check(kind, userEmail);
  const row = db.prepare(`SELECT payload_json, created_at FROM ai_proposals
                           WHERE kind = ? AND user_email = ? AND IFNULL(book_id, 0) = ?`)
    .get(kind, userEmail, bookId || 0);
  if (!row) return null;
  try { return { payload: JSON.parse(row.payload_json), created_at: row.created_at }; }
  catch { return null; }
}

/** Vorschlag erledigt (übernommen oder verworfen). Liefert die Zahl gelöschter Zeilen. */
function deleteProposal(kind, userEmail, bookId) {
  _check(kind, userEmail);
  return db.prepare('DELETE FROM ai_proposals WHERE kind = ? AND user_email = ? AND IFNULL(book_id, 0) = ?')
    .run(kind, userEmail, bookId || 0).changes;
}

module.exports = { PROPOSAL_KINDS, saveProposal, getProposal, deleteProposal };
