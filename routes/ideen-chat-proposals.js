'use strict';
// Ideen-Vorschläge aus Chats — gemountet unter /ideen (routes/ideen.js, vor `/:id`):
//   PATCH /ideen/chat-proposal  Status übernommen/verworfen/wieder offen
//     (Fabrik routes/chat-proposal-status.js). Sessions der Arten `ideen`
//     (Ideen-Chat) sowie `page`/`book` (Abschnitts- und Buch-Chat, deren
//     idee_create-Vorschläge: lib/chat-idee-proposals.js).
//   POST  /ideen/chat-proposal/beleg-check  Steht der Beleg eines «erledigt»-
//     Vorschlags (Ideen-Chat) noch im AKTUELLEN Abschnittstext? Das Frontend
//     fragt vor dem Übernehmen (public/js/chat/ideen-chat-proposals.js); geprüft
//     mit derselben Normalisierung wie beim Vorschlagen
//     (routes/jobs/ideen-chat-tools.js#belegInPage). Kein KI-Call.
// Deep-Doc: docs/ideen-chat.md

const express = require('express');
const { db } = require('../db/schema');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const { getOwnedSession } = require('../db/chat-sessions');
const { setContext } = require('../lib/log-context');
const ideenDb = require('../db/ideen');
const { makeChatProposalStatusRouter } = require('./chat-proposal-status');
const { belegInPage } = require('./jobs/ideen-chat-tools');

// Gibt es die von einem übernommenen idee_create angelegte Idee noch? Nach dem
// Löschen darf der Vorschlag erneut übernommen werden.
function ideenAppliedExists(p, { bookId, userEmail }) {
  if (p?.type !== 'idee_create') return undefined;
  const row = p.applied_id ? ideenDb.getIdeeOwned(p.applied_id, userEmail) : null;
  return !!row && row.book_id === bookId;
}

const router = express.Router();
router.use('/', makeChatProposalStatusRouter({ kinds: ['ideen', 'page', 'book'], appliedExists: ideenAppliedExists }));

router.post('/chat-proposal/beleg-check', express.json(), async (req, res) => {
  const userEmail = sessionEmail(req);
  const messageId = toIntId(req.body?.message_id);
  const index = Number.isInteger(req.body?.index) ? req.body.index : -1;
  if (!messageId || index < 0) return res.status(400).json({ error_code: 'INVALID_ID' });
  const msg = db.prepare(
    "SELECT session_id, context_info FROM chat_messages WHERE id = ? AND role = 'assistant'"
  ).get(messageId);
  const session = msg ? getOwnedSession(msg.session_id, userEmail) : null;
  if (!session || session.kind !== 'ideen') return res.status(404).json({ error_code: 'PROPOSAL_NOT_FOUND' });
  setContext({ book: session.book_id });
  if (!guardBook(req, res, session.book_id, 'editor')) return;
  let ci;
  try { ci = JSON.parse(msg.context_info || '{}') || {}; } catch { ci = {}; }
  const p = Array.isArray(ci.proposals) ? ci.proposals[index] : null;
  if (!p) return res.status(404).json({ error_code: 'PROPOSAL_NOT_FOUND' });
  const pageId = toIntId(p.beleg?.page_id);
  if (!p.beleg?.text || !pageId) return res.json({ checked: false, found: null });
  res.json({ checked: true, found: await belegInPage(pageId, p.beleg.text, session.book_id) });
});

module.exports = { ideenChatProposalsRouter: router, ideenAppliedExists };
