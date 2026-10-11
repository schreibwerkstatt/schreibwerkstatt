// Status eines Chat-Vorschlags persistieren — Frontend-Gegenstück zur geteilten
// Server-Fabrik routes/chat-proposal-status.js. Konsumenten: Plot-Chat
// (PATCH /plot/chat-proposal, plot-chat-proposals.js), Ideen-Chat und die
// Ideen-Vorschläge aus Abschnitts- und Buch-Chat (PATCH /ideen/chat-proposal,
// ideen-chat-proposals.js bzw. chat-idee-proposals.js).

import { fetchJson } from '../utils.js';

// Felder, die der Server am Vorschlag führt; transiente (_busy, _error, …) bleiben.
const PERSISTED_KEYS = ['applied_at', 'applied_id', 'status'];

/**
 * Setzt den Status von msg.context_info.proposals[index] auf dem Server
 * (action: 'applied' | 'discarded' | 'reopen') und übernimmt den persistierten
 * Stand ins Vorschlagsobjekt. Wirft bei Fehler (fetchJson).
 */
export async function persistProposalStatus(url, msg, index, action, appliedId = null) {
  const res = await fetchJson(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message_id: msg.id, index, action,
      ...(appliedId ? { applied_id: appliedId } : {}),
    }),
  });
  const p = msg?.context_info?.proposals?.[index];
  if (p && res?.proposal) {
    for (const k of PERSISTED_KEYS) {
      if (k in res.proposal) p[k] = res.proposal[k];
      else delete p[k];
    }
  }
  return res?.proposal || null;
}
