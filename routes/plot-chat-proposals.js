'use strict';
// Status eines Plot-Chat-Vorschlags persistieren — PATCH /plot/chat-proposal.
// Logik geteilt mit dem Ideen-Chat: routes/chat-proposal-status.js.
// Deep-Doc: docs/plot-chat.md

const { makeChatProposalStatusRouter } = require('./chat-proposal-status');
const plotDb = require('../db/plot');

const GETTERS = { beat_create: plotDb.getBeatMeta, act_create: plotDb.getAct, thread_create: plotDb.getThread };

// Gibt es das von einem übernommenen create-Vorschlag Angelegte noch (im selben
// Buch, beim selben User)? Nach Undo/Löschen darf er erneut übernommen werden.
function plotAppliedExists(p, { bookId, userEmail }) {
  const get = GETTERS[p?.type];
  if (!get) return undefined;
  const row = p.applied_id ? get(p.applied_id) : null;
  return !!row && row.book_id === bookId && row.user_email === userEmail;
}

module.exports = {
  plotChatProposalsRouter: makeChatProposalStatusRouter({ kinds: ['plot'], appliedExists: plotAppliedExists }),
  plotAppliedExists,
};
