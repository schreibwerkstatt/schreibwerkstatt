'use strict';
// Anzeigenamen der Objekte, auf die ein Werkzeug-Aufruf der agentischen Chats
// per ID zeigt (Figur, Akt, Beat, Strang, Ort, Idee, Motiv, Recherche-Eintrag,
// Werkstatt-Figur). Liest der Werkzeug-Verlauf (routes/jobs/agentic-chat/
// tool-view.js) beim Speichern einer Antwort, damit dort «Stefan» statt `fig_1`
// steht. Seiten-/Kapitelnamen kommen aus db/content-names.js.
//
// Rein lesend, immer auf das Buch des Chats begrenzt: eine ID aus einem fremden
// Buch löst nicht auf.

const { db } = require('./connection');

function _in(ids) {
  return `(${ids.map(() => '?').join(',')})`;
}

// Figuren tragen `fig_id` als Text (pro Buch eindeutig, aber je Analyse-Lauf des
// Users eine eigene Zeile) — der eigene Stand gewinnt vor fremden.
function _figureNames(bookId, userEmail, figIds) {
  const rows = db.prepare(`
    SELECT fig_id AS id, name FROM figures
     WHERE book_id = ? AND fig_id IN ${_in(figIds)}
     ORDER BY (user_email IS ?) ASC
  `).all(bookId, ...figIds, userEmail || null);
  // ORDER BY … ASC: eigene Zeile (Vergleich = 1) zuletzt → überschreibt fremde.
  return new Map(rows.map(r => [String(r.id), r.name]));
}

const _SIMPLE = {
  act:      { table: 'plot_acts',      col: 'name' },
  beat:     { table: 'plot_beats',     col: 'titel' },
  thread:   { table: 'plot_threads',   col: 'name' },
  location: { table: 'locations',      col: 'name', idCol: 'loc_id' },
  idee:     { table: 'ideen',          col: 'content' },
  motif:    { table: 'motifs',         col: 'name' },
  research: { table: 'research_items', col: 'title' },
  draft:    { table: 'draft_figures',  col: 'name' },
};

/**
 * Namen je Art auflösen.
 * @param {number} bookId
 * @param {string|null} userEmail
 * @param {{ [kind: string]: Array<string|number> }} wanted  kind ∈ figure | act | beat | thread | location | idee | motif | research | draft
 * @returns {{ [kind: string]: Map<string, string> }} Schlüssel immer als String
 */
function toolRefNames(bookId, userEmail, wanted) {
  const out = {};
  for (const [kind, raw] of Object.entries(wanted || {})) {
    const ids = [...new Set((raw || []).map(String).filter(Boolean))].slice(0, 200);
    if (!ids.length) continue;
    if (kind === 'figure') { out.figure = _figureNames(bookId, userEmail, ids); continue; }
    const spec = _SIMPLE[kind];
    if (!spec) continue;
    const idCol = spec.idCol || 'id';
    const rows = db.prepare(`
      SELECT ${idCol} AS id, ${spec.col} AS name FROM ${spec.table}
       WHERE book_id = ? AND ${idCol} IN ${_in(ids)}
    `).all(bookId, ...ids);
    out[kind] = new Map(rows.map(r => [String(r.id), String(r.name || '')]));
  }
  return out;
}

module.exports = { toolRefNames };
