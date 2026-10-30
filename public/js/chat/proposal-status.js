// Status eines Chat-Vorschlags persistieren — Frontend-Gegenstück zur geteilten
// Server-Fabrik routes/chat-proposal-status.js. Konsumenten: Plot-Chat
// (PATCH /plot/chat-proposal, plot-chat-proposals.js), Ideen-Chat und die
// Ideen-Vorschläge aus Abschnitts- und Buch-Chat (PATCH /ideen/chat-proposal,
// ideen-chat-proposals.js bzw. chat-idee-proposals.js).

import { fetchJson } from '../utils.js';

// Felder, die der Server am Vorschlag führt; transiente (_busy, _error, _written, …) bleiben.
const PERSISTED_KEYS = ['applied_at', 'applied_id', 'status'];

function _adopt(msg, index, proposal) {
  const p = msg?.context_info?.proposals?.[index];
  if (p && proposal) {
    for (const k of PERSISTED_KEYS) {
      if (k in proposal) p[k] = proposal[k];
      else delete p[k];
    }
  }
}

/**
 * Setzt den Status von msg.context_info.proposals[index] auf dem Server
 * (action: 'applied' | 'discarded' | 'reopen') und übernimmt den persistierten
 * Stand ins Vorschlagsobjekt. Wirft bei Fehler (fetchJson).
 *
 * `409 PROPOSAL_ALREADY_APPLIED` ist kein Fehler, sondern der Stand: der
 * Vorschlag ist schon übernommen (anderer Tab, verlorene Antwort eines ersten
 * Versuchs). Der Server schickt den gespeicherten Vorschlag mit; er wird
 * übernommen und zurückgegeben (`already: true`), nichts wird überschrieben.
 */
export async function persistProposalStatus(url, msg, index, action, appliedId = null) {
  let res;
  try {
    res = await fetchJson(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message_id: msg.id, index, action,
        ...(appliedId ? { applied_id: appliedId } : {}),
      }),
    });
  } catch (e) {
    if (e?.status === 409 && e.code === 'PROPOSAL_ALREADY_APPLIED' && e.body?.proposal) {
      _adopt(msg, index, e.body.proposal);
      return { ...e.body.proposal, already: true };
    }
    throw e;
  }
  _adopt(msg, index, res?.proposal);
  return res?.proposal || null;
}

/**
 * Einen Vorschlag übernehmen, ohne ihn doppelt zu schreiben: `write()` legt an
 * bzw. ändert über die regulären Routen und liefert die id des Angelegten bzw.
 * Geänderten; danach hält `persistProposalStatus` den Status fest. Scheitert
 * nur der Status, merkt sich der Vorschlag (transient `_written`, `_appliedId`),
 * dass das Board schon geschrieben ist — ein zweiter Klick holt nur den Status
 * nach, statt ein Duplikat anzulegen.
 * → { ok: true } | { ok: false, phase: 'write'|'persist', error }
 */
export async function applyProposalOnce(url, msg, index, write) {
  const p = msg?.context_info?.proposals?.[index];
  if (!p) return { ok: false, phase: 'write', error: new Error('proposal missing') };
  if (!p._written) {
    try {
      p._appliedId = (await write()) ?? null;
      p._written = true;
    } catch (error) {
      return { ok: false, phase: 'write', error };
    }
  }
  try {
    await persistProposalStatus(url, msg, index, 'applied', p._appliedId);
  } catch (error) {
    return { ok: false, phase: 'persist', error };
  }
  delete p._written;
  delete p._appliedId;
  return { ok: true };
}
