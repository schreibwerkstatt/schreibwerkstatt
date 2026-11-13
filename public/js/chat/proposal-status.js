// Status eines Chat-Vorschlags persistieren — Frontend-Gegenstück zur geteilten
// Server-Fabrik routes/chat-proposal-status.js. Konsumenten: Plot-Chat
// (PATCH /plot/chat-proposal, plot-chat-proposals.js), Ideen-Chat und die
// Ideen-Vorschläge aus Abschnitts- und Buch-Chat (PATCH /ideen/chat-proposal,
// ideen-chat-proposals.js bzw. chat-idee-proposals.js).

import { fetchJson } from '../utils.js';
import { tFetchError, tRaw } from '../i18n.js';

// Felder, die der Server am Vorschlag führt; transiente (_busy, _error, _written, …) bleiben.
const PERSISTED_KEYS = ['applied_at', 'applied_id', 'status', 'claimed_at'];

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
export async function persistProposalStatus(url, msg, index, action, appliedId = null, { force = false } = {}) {
  let res;
  try {
    res = await fetchJson(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message_id: msg.id, index, action,
        ...(appliedId ? { applied_id: appliedId } : {}),
        ...(force ? { force: true } : {}),
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
 *
 * Vor dem Schreiben reserviert der Server den Vorschlag (`claim`): ein anderer Tab,
 * der ihn schon übernommen hat, liefert den Stand zurück (`already`), statt dass
 * hier ein zweites Mal geschrieben wird. Hängt eine Reservierung ohne Bestätigung
 * (Status-PATCH eines früheren Versuchs verloren, die transiente Markierung mit
 * dem Nachladen weg), fragt `confirmReclaim()` nach, ob trotzdem geschrieben wird.
 * → { ok: true, already? } | { ok: false, phase: 'write'|'persist'|'cancelled', error }
 */
function _confirmReclaim() {
  const app = typeof window !== 'undefined' ? window.__app : null;
  if (!app?.appConfirm) return Promise.resolve(false);
  return app.appConfirm({ message: app.t('chat.proposalReclaimConfirm') });
}

export async function applyProposalOnce(url, msg, index, write, { confirmReclaim = _confirmReclaim } = {}) {
  const p = msg?.context_info?.proposals?.[index];
  if (!p) return { ok: false, phase: 'write', error: new Error('proposal missing') };
  if (!p._written) {
    try {
      const claimed = await persistProposalStatus(url, msg, index, 'claim');
      if (claimed?.already) return { ok: true, already: true };
    } catch (error) {
      if (error?.status !== 409 || error.code !== 'PROPOSAL_CLAIMED') return { ok: false, phase: 'write', error };
      if (!confirmReclaim || !(await confirmReclaim())) return { ok: false, phase: 'cancelled', error };
      try {
        const claimed = await persistProposalStatus(url, msg, index, 'claim', null, { force: true });
        if (claimed?.already) return { ok: true, already: true };
      } catch (e) {
        return { ok: false, phase: 'write', error: e };
      }
    }
    try {
      p._appliedId = (await write()) ?? null;
      p._written = true;
    } catch (error) {
      // Nichts geschrieben: Reservierung freigeben (best effort — scheitert auch
      // das, fragt der nächste Klick nach).
      persistProposalStatus(url, msg, index, 'unclaim').catch(() => {});
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

/**
 * Fehlertext für ein gescheitertes `applyProposalOnce`-Ergebnis, `null` bei
 * Erfolg oder Abbruch. `write`: das Board wurde nicht geändert — Server-Grund,
 * sonst `applyKey`. `persist`: geändert, nur der Status fehlt — `statusKey`
 * (der nächste Klick holt nur den Status nach). Geteilt von Plot- und Ideen-Chat.
 */
export function proposalApplyError(r, { applyKey, statusKey }) {
  if (!r || r.ok || r.phase === 'cancelled') return null;
  if (r.phase === 'write') return r.error?.body ? tFetchError(r.error) : tRaw(applyKey);
  return tRaw(statusKey);
}
