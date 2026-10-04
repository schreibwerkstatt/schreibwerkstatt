'use strict';
// Status eines Chat-Vorschlags persistieren (context_info.proposals[i] der
// Assistant-Nachricht) — geteilt von Plot-Chat (PATCH /plot/chat-proposal) und
// Ideen-Chat (PATCH /ideen/chat-proposal). Das Übernehmen selbst läuft im
// Frontend über die normalen Routen des jeweiligen Boards (gleiche Validierung
// wie jede Bearbeitung); hier wird nur festgehalten, DASS und WOMIT übernommen
// bzw. dass verworfen wurde — sonst stünde der Vorschlag nach einem Reload
// wieder offen da und der nächste Turn hielte ihn für unbearbeitet.
//
// PATCH <mount>/chat-proposal
//   Body: { message_id, index, action: 'applied'|'discarded'|'reopen', applied_id? }
//   applied   → applied_at + applied_id (id des Angelegten bzw. Geänderten),
//               hebt ein „verworfen" auf. Erneutes Übernehmen (z.B. nach Undo
//               des Angelegten) überschreibt applied_id.
//   discarded → status='discarded' (409, wenn schon übernommen)
//   reopen    → hebt „verworfen" auf
// Besitz über die Session (pro User) und deren `kind` — ein Plot-Vorschlag
// lässt sich nicht über die Ideen-Route setzen und umgekehrt.

const express = require('express');
const { db } = require('../db/schema');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const { getOwnedSession } = require('../db/chat-sessions');
const { setContext } = require('../lib/log-context');

const ACTIONS = new Set(['applied', 'discarded', 'reopen']);

/** Router mit `PATCH /chat-proposal` für Sessions der Art `kind` (Buch-ACL editor). */
function makeChatProposalStatusRouter({ kind }) {
  const router = express.Router();
  const jsonBody = express.json();

  router.patch('/chat-proposal', jsonBody, (req, res) => {
    const userEmail = sessionEmail(req);
    const messageId = toIntId(req.body?.message_id);
    const index = Number.isInteger(req.body?.index) ? req.body.index : -1;
    const action = req.body?.action;
    if (!messageId || index < 0) return res.status(400).json({ error_code: 'INVALID_ID' });
    if (!ACTIONS.has(action)) return res.status(400).json({ error_code: 'INVALID_ACTION' });

    const msg = db.prepare(
      "SELECT id, session_id FROM chat_messages WHERE id = ? AND role = 'assistant'"
    ).get(messageId);
    // Besitz über die Session (pro User). Fremde Nachricht = 404, kein 403.
    const session = msg ? getOwnedSession(msg.session_id, userEmail) : null;
    if (!session || session.kind !== kind) return res.status(404).json({ error_code: 'PROPOSAL_NOT_FOUND' });
    if (!guardBook(req, res, session.book_id, 'editor')) return;
    setContext({ book: session.book_id });

    let status = 200;
    let body = null;
    // Lesen + Schreiben in einer Transaktion: zwei schnelle Klicks auf verschiedene
    // Vorschläge derselben Nachricht dürfen sich nicht gegenseitig überschreiben.
    db.transaction(() => {
      const row = db.prepare('SELECT context_info FROM chat_messages WHERE id = ?').get(messageId);
      let ci;
      try { ci = JSON.parse(row?.context_info || '{}') || {}; } catch { ci = {}; }
      const p = Array.isArray(ci.proposals) ? ci.proposals[index] : null;
      if (!p) { status = 404; body = { error_code: 'PROPOSAL_NOT_FOUND' }; return; }
      const next = { ...p };
      if (action === 'applied') {
        next.applied_at = new Date().toISOString();
        const appliedId = toIntId(req.body?.applied_id);
        if (appliedId) next.applied_id = appliedId;
        delete next.status;
      } else if (action === 'discarded') {
        if (p.applied_at) { status = 409; body = { error_code: 'PROPOSAL_ALREADY_APPLIED' }; return; }
        next.status = 'discarded';
      } else {
        delete next.status;
      }
      ci.proposals[index] = next;
      db.prepare('UPDATE chat_messages SET context_info = ? WHERE id = ?').run(JSON.stringify(ci), messageId);
      body = { proposal: next };
    })();
    res.status(status).json(body);
  });

  return router;
}

module.exports = { makeChatProposalStatusRouter };
