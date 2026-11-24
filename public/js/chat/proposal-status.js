// Status eines Chat-Vorschlags persistieren — Frontend-Gegenstück zur geteilten
// Server-Fabrik routes/chat-proposal-status.js. Konsumenten: Plot-Chat
// (PATCH /plot/chat-proposal, plot-chat-proposals.js), Ideen-Chat und die
// Ideen-Vorschläge aus Abschnitts-, Buch- und Recherche-Chat (PATCH
// /ideen/chat-proposal, ideen-chat-proposals.js bzw. chat-idee-proposals.js),
// Änderungsvorschläge des Recherche-Chats (PATCH /research/chat-proposal,
// research-chat-changes.js: nur Status + Grundzustand, Übernehmen hat dort eine
// eigene Route). Dazu Übernehmen/Verwerfen der Board-Chats (Plot, Ideen) als
// Fabrik `makeProposalApplyMethods` samt dem Prädikat «übernehmbar».

import { fetchJson } from '../utils.js';
import { tFetchError, tRaw } from '../i18n.js';
import { trackChatProposal } from '../features-usage.js';

/** Persistierter Grundzustand: 'applied' | 'discarded' | 'open'. Die Chats
 *  verfeinern ihn gegen ihren Bestand (z.B. «übernommen, aber Angelegtes weg»). */
export function proposalBaseState(p) {
  if (p?.applied_at) return 'applied';
  return p?.status === 'discarded' ? 'discarded' : 'open';
}

/**
 * Darf der Vorschlag (jetzt) übernommen werden? `st` = Zustand des Chats
 * ({ state, blocked }). Eine Blockade sperrt nur, solange nichts geschrieben ist:
 * ist das Board schon geändert (`_written`) und fehlt nur der Status, holt ein
 * Klick den Status nach — auch wenn der Bestand jetzt blockieren würde (die
 * gemergte Idee ist weg, die Verknüpfung steht schon). Gilt für Knopf UND Code.
 */
export function proposalCanApply(st, p) {
  return st?.state === 'open' && (!st.blocked || !!p?._written);
}

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

/**
 * Übernehmen/Verwerfen eines Board-Chats (Plot, Ideen) als Methoden-Objekt.
 * `this` ist die Karte (mit `busy`/`errorMessage`). Jeder Vorschlag einzeln,
 * über applyProposalOnce (kein Duplikat, wenn nur der Status scheitert).
 * @param {object} cfg
 * @param {string} cfg.url       Status-Route (PATCH …/chat-proposal)
 * @param {string} cfg.chat      Usage-Kennung ('plot' | 'ideen')
 * @param {{ list: string, status: string, canApply: string, apply: string, discard: string }} cfg.names
 *                               Methodennamen: Vorschlagsliste + Zustand lesen (vorhanden),
 *                               canApply/apply/discard werden erzeugt
 * @param {string} cfg.applyKey / cfg.statusKey  Fehlertexte (proposalApplyError)
 * @param {Function} cfg.write   (p, list) → id des Geschriebenen; wirft bei Fehler
 * @param {Function} [cfg.locked]      () → true = jetzt nicht (z.B. Undo läuft)
 * @param {Function} [cfg.beforeApply] (p) synchron vor allem (offenes Panel schliessen)
 * @param {Function} [cfg.confirmFirst] (msg, pi, p) → true = weiter; nur vor dem ersten Schreiben
 * @param {Function} [cfg.afterWrite]  (p, id) direkt nach dem Schreiben (busy schon frei)
 * @param {Function} [cfg.afterApply]  (p, id) nach dem Status — auch wenn nur der Status scheiterte
 */
export function makeProposalApplyMethods(cfg) {
  const n = cfg.names;
  return {
    [n.canApply](msg, pi) {
      const p = this[n.list](msg)[pi];
      if (!p || p._applying || this.busy || cfg.locked?.call(this)) return false;
      return proposalCanApply(this[n.status](msg, pi), p);
    },

    async [n.apply](msg, pi) {
      const list = this[n.list](msg);
      const p = list[pi];
      if (!this[n.canApply](msg, pi)) return;
      cfg.beforeApply?.call(this, p);
      p._applying = true;
      p._error = '';
      let writtenId = null;
      let written = false;
      try {
        if (!p._written && cfg.confirmFirst && !(await cfg.confirmFirst.call(this, msg, pi, p))) return;
        this.busy = true;
        const r = await applyProposalOnce(cfg.url, msg, pi, async () => {
          const id = await cfg.write.call(this, p, list);
          writtenId = id;
          written = true;
          this.busy = false;
          this.errorMessage = '';
          if (cfg.afterWrite) await cfg.afterWrite.call(this, p, id);
          return id;
        });
        if (written && cfg.afterApply) await cfg.afterApply.call(this, p, writtenId);
        if (r.ok) { if (!r.already) trackChatProposal(cfg.chat, 'applied', p.type); return; }
        const err = proposalApplyError(r, { applyKey: cfg.applyKey, statusKey: cfg.statusKey });
        if (err) p._error = err;
      } finally {
        this.busy = false;
        p._applying = false;
      }
    },

    async [n.discard](msg, pi, discard = true) {
      const p = this[n.list](msg)[pi];
      if (!p || p._applying) return;
      p._error = '';
      try {
        await persistProposalStatus(cfg.url, msg, pi, discard ? 'discarded' : 'reopen');
        trackChatProposal(cfg.chat, discard ? 'discarded' : 'reopened', p.type);
      } catch (e) {
        p._error = tFetchError(e);
      }
    },
  };
}
