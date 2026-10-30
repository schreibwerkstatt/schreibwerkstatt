'use strict';
// Gemeinsame Bausteine der beiden Vorschlags-Chats (Plot-Chat, Ideen-Chat) neben
// dem Job-Gerüst (proposal-chat.js): Handler-Eingabe säubern, Vorschlag sammeln,
// Status eines gespeicherten Vorschlags und das Session-Gedächtnis früherer
// Vorschläge. Die chat-eigenen Achsen (Label je Vorschlag, ob das Angelegte noch
// existiert) kommen als Callback herein.

const { db } = require('../../db/schema');
const { str } = require('../../lib/proposal-input');

const MAX_BEGRUENDUNG = 600;
// Länge eines Vorschlags im Gedächtnis-Block — beide Chats gleich.
const MEMORY_LABEL_MAX = 140;
const MEMORY_LIMIT = 40;

function err(msg) { return { error: msg }; }

/**
 * Leere Werte entfernen, BEVOR ein Vorschlags-Handler sie sieht — in beiden
 * Pfaden gleich (klassisch: Constrained Decoding schickt jedes Feld mit,
 * agentisch: Modelle füllen optionale Felder gern mit null/""/0). Ein leerer
 * Wert heisst darum überall «nicht angegeben»; Leeren ist eine eigene, explizite
 * Angabe im Werkzeug (`leeren` bzw. `anker_loesen`).
 */
function cleanProposalInput(v) {
  const out = {};
  for (const [k, val] of Object.entries(v || {})) {
    if (k === 'werkzeug') continue;
    if (val === null || val === undefined || val === 0) continue;
    if (typeof val === 'string' && !val.trim()) continue;
    if (Array.isArray(val) && !val.length) continue;
    out[k] = val;
  }
  return out;
}

/** Vorschlag an ctx.proposals hängen (ref = Index + 1) und dem Modell quittieren. */
function pushProposal(ctx, proposal, input) {
  const begruendung = str(input?.begruendung, MAX_BEGRUENDUNG);
  const p = { ...proposal, ref: ctx.proposals.length + 1, ...(begruendung ? { begruendung } : {}) };
  ctx.proposals.push(p);
  return { ok: true, ref: p.ref, hinweis: 'Vorschlag gesammelt — der User übernimmt ihn selbst. Nicht wiederholen.' };
}

/**
 * Status eines gespeicherten Vorschlags: applied / removed / discarded / open.
 * `removed` = übernommen, aber das damit Angelegte gibt es nicht mehr (Undo,
 * gelöscht) — `createdExists(p)` liefert dafür false; für Vorschläge, die nichts
 * anlegen, undefined.
 */
function proposalState(p, createdExists = null) {
  if (p?.applied_at) {
    if (createdExists && createdExists(p) === false) return 'removed';
    return 'applied';
  }
  if (p?.status === 'discarded') return 'discarded';
  return 'open';
}

/**
 * Frühere Vorschläge einer Session, kompakt — für den Gedächtnis-Block im Prompt
 * („nimm den dritten", „nicht nochmal vorschlagen").
 * @param {number} sessionId
 * @param {{ label(p): string, typeLabels: object, createdExists?: (p) => boolean|undefined }} opts
 */
function sessionProposalMemory(sessionId, { label, typeLabels, createdExists = null, limit = MEMORY_LIMIT }) {
  const rows = db.prepare(
    `SELECT context_info FROM chat_messages
      WHERE session_id = ? AND role = 'assistant' AND context_info LIKE '%"proposals"%'
      ORDER BY created_at ASC, id ASC`
  ).all(sessionId);
  const out = [];
  for (const r of rows) {
    let ci;
    try { ci = JSON.parse(r.context_info); } catch { continue; }
    for (const p of Array.isArray(ci?.proposals) ? ci.proposals : []) {
      const l = label(p);
      if (!l) continue;
      out.push({
        type: typeLabels[p.type] || p.type,
        label: String(l).slice(0, MEMORY_LABEL_MAX),
        state: proposalState(p, createdExists),
      });
    }
  }
  return out.slice(-limit);
}

function oneLine(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

module.exports = {
  MAX_BEGRUENDUNG, MEMORY_LABEL_MAX,
  err, cleanProposalInput, pushProposal, proposalState, sessionProposalMemory, oneLine,
};
