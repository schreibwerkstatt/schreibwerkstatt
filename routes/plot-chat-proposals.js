'use strict';
// Status eines Plot-Chat-Vorschlags persistieren — PATCH /plot/chat-proposal.
// Logik geteilt mit dem Ideen-Chat: routes/chat-proposal-status.js.
// Deep-Doc: docs/plot-chat.md

const { makeChatProposalStatusRouter } = require('./chat-proposal-status');

module.exports = { plotChatProposalsRouter: makeChatProposalStatusRouter({ kinds: ['plot'] }) };
