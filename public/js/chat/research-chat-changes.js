// Änderungsvorschläge des Recherche-Chats an BESTEHENDEN Fundstücken
// (`type` research_update / research_archive / research_merge) — Methoden,
// gespreadet über researchChatMethods in die rechercheCard.
//
// Jeder Vorschlag einzeln (kein «alle übernehmen»): Übernehmen schreibt über
// POST /research/chat-proposal/apply — der Server ändert den Eintrag und hält
// «übernommen» in derselben Transaktion fest. Verwerfen/Wieder öffnen über
// PATCH /research/chat-proposal (persistProposalStatus, geteilt mit Plot- und
// Ideen-Chat). Der Index ist der ECHTE Index in context_info.proposals (neue
// Fundstücke stehen davor, Ideen dahinter).
//
// Vor dem Übernehmen darf der User den vorgeschlagenen Text ändern
// (`_changeEdits`) und URLs weglassen (dieselbe Mechanik wie bei neuen
// Fundstücken: `_proposalRemovedUrls`, ungeprüfte vorab abgewählt).
//
// Lokale Updates ersetzen die Nachricht im Array (wie research-chat-proposals.js).
import { sendJson } from '../utils.js';
import { trackChatProposal } from '../features-usage.js';
import { persistProposalStatus } from './proposal-status.js';

const CHANGE_TYPES = new Set(['research_update', 'research_archive', 'research_merge']);
const STATUS_URL = '/research/chat-proposal';
const _key = (msg, idx) => `${msg?.id ?? 'x'}:${idx}`;
// Text-Felder, die der User vor dem Übernehmen bearbeiten darf.
const EDITABLE = ['title', 'body', 'append'];

export const researchChangeMethods = {
  researchChangeProposals(msg) {
    return ((msg?.context_info?.proposals) || [])
      .map((p, idx) => ({ p, idx }))
      .filter(({ p }) => CHANGE_TYPES.has(p?.type));
  },
  researchChangeState(p) {
    if (p?.applied_at) return 'applied';
    return p?.status === 'discarded' ? 'discarded' : 'open';
  },
  researchChangeLabel(p) {
    const t = window.__app.t;
    const state = this.researchChangeState(p);
    if (state === 'applied') return t('recherche.chat.change.applied');
    if (state === 'discarded') return t('chat.discarded');
    return t(`recherche.chat.change.type.${p.type}`);
  },
  isResearchChangeBusy(msg, idx) { return !!this._proposalSaving[`chg:${_key(msg, idx)}`]; },

  // Vorher → nachher je ersetztem Feld; Status mit Beschriftung.
  researchChangeRows(p) {
    const t = window.__app.t;
    const f = p?.fields || {};
    const rows = [];
    for (const k of ['title', 'body', 'source']) {
      if (f[k] === undefined || p.type !== 'research_update') continue;
      rows.push({ key: k, label: t(`recherche.chat.change.field.${k}`), before: p.before?.[k] || '', after: f[k] });
    }
    if (f.status) {
      rows.push({
        key: 'status', label: t('recherche.status.label'),
        before: t(`recherche.status.${p.before?.status || 'offen'}`), after: t(`recherche.status.${f.status}`),
      });
    }
    return rows;
  },

  // ── Bearbeiten vor dem Übernehmen ───────────────────────────────────────
  researchChangeEditable(p) {
    return this.researchChangeState(p) === 'open' && EDITABLE.some(k => p?.fields?.[k] !== undefined);
  },
  researchChangeEdit(msg, idx) { return this._changeEdits[_key(msg, idx)] || null; },
  toggleResearchChangeEdit(msg, idx) {
    const k = _key(msg, idx);
    const next = { ...this._changeEdits };
    if (next[k]) delete next[k];
    else {
      const f = msg?.context_info?.proposals?.[idx]?.fields || {};
      next[k] = Object.fromEntries(EDITABLE.filter(n => f[n] !== undefined).map(n => [n, f[n]]));
    }
    this._changeEdits = next;
  },
  _keptChangeUrls(msg, idx, p) {
    return (p?.urls || []).filter(u => !this.isProposalUrlRemoved(msg, idx, u));
  },

  // Vorschlag lokal ersetzen — neue Nachricht im Array, damit das Template es sieht.
  _replaceChangeProposal(msg, idx, proposal) {
    this.researchChatMessages = this.researchChatMessages.map(m => {
      if (m !== msg && !(m.id && m.id === msg.id)) return m;
      const proposals = [...(m.context_info?.proposals || [])];
      proposals[idx] = proposal;
      return { ...m, context_info: { ...m.context_info, proposals } };
    });
  },
  _setChangeError(msg, idx, error) {
    const p = msg?.context_info?.proposals?.[idx];
    if (p) this._replaceChangeProposal(msg, idx, { ...p, _error: error || undefined });
  },

  async applyResearchChange(msg, idx, { ignoreBeleg = false } = {}) {
    const app = window.__app;
    const p = msg?.context_info?.proposals?.[idx];
    const k = `chg:${_key(msg, idx)}`;
    if (!msg?.id || !p || this.researchChangeState(p) !== 'open' || this._proposalSaving[k]) return;
    // Zusammenführen löscht einen Eintrag — einmal ausdrücklich bestätigen.
    if (p.type === 'research_merge' && !ignoreBeleg) {
      const ok = await app.appConfirm({
        message: app.t('recherche.chat.change.mergeConfirm', { from: p.labels?.merge_item || '', into: p.labels?.item || '' }),
        danger: true,
      });
      if (!ok) return;
    }
    this._proposalSaving = { ...this._proposalSaving, [k]: true };
    this._setChangeError(msg, idx, null);
    try {
      const d = this.researchChangeEdit(msg, idx);
      const all = p.urls || [];
      const kept = this._keptChangeUrls(msg, idx, p);
      const edits = {
        ...(d || {}),
        ...(kept.length !== all.length ? { urls: kept.map(u => u.url) } : {}),
      };
      const res = await sendJson('/research/chat-proposal/apply', 'POST', {
        message_id: msg.id, index: idx,
        ...(Object.keys(edits).length ? { edits } : {}),
        ...(ignoreBeleg ? { ignore_beleg: true } : {}),
      });
      this._replaceChangeProposal(msg, idx, res?.proposal || { ...p, applied_at: new Date().toISOString() });
      trackChatProposal('research', 'applied', p.type.replace('research_', ''));
      if (this._changeEdits[_key(msg, idx)]) { const n = { ...this._changeEdits }; delete n[_key(msg, idx)]; this._changeEdits = n; }
      await this.loadRecherche();
    } catch (e) {
      const code = e?.body?.error_code;
      if (e?.status === 409 && code === 'BELEG_MISSING') {
        // Erst die Sperre lösen, dann fragen: der zweite Aufruf setzt sie neu.
        const next = { ...this._proposalSaving }; delete next[k]; this._proposalSaving = next;
        const ok = await app.appConfirm({ message: app.t('recherche.chat.change.belegMissingConfirm') });
        if (ok) await this.applyResearchChange(msg, idx, { ignoreBeleg: true });
        return;
      }
      if (e?.status === 409 && code === 'PROPOSAL_ALREADY_APPLIED' && e.body?.proposal) {
        this._replaceChangeProposal(msg, idx, e.body.proposal);
        return;
      }
      // Codes mit eigenem Satz für diese Karte (BODY_TOO_LONG/ITEM_NOT_FOUND tragen
      // unter error.* den Wortlaut anderer Karten); der Rest über error.<CODE>.
      const own = ['PROPOSAL_STALE', 'ITEM_NOT_FOUND', 'BODY_TOO_LONG', 'TOO_MANY_URLS', 'TOO_MANY_TAGS', 'MERGE_MEDIA'];
      const key = own.includes(code) ? `recherche.chat.change.error.${code}`
        : (code === 'PROPOSAL_DISCARDED' ? 'error.PROPOSAL_DISCARDED' : 'recherche.chat.change.error.generic');
      this._setChangeError(msg, idx, app.t(key, e?.body?.params || {}));
    } finally {
      const next = { ...this._proposalSaving };
      delete next[k];
      this._proposalSaving = next;
    }
  },

  async toggleDiscardResearchChange(msg, idx) {
    const app = window.__app;
    const p = msg?.context_info?.proposals?.[idx];
    const k = `chg:${_key(msg, idx)}`;
    if (!p || this._proposalSaving[k]) return;
    const discard = this.researchChangeState(p) !== 'discarded';
    this._proposalSaving = { ...this._proposalSaving, [k]: true };
    try {
      const saved = await persistProposalStatus(STATUS_URL, msg, idx, discard ? 'discarded' : 'reopen');
      const { status: _drop, ...rest } = p;
      this._replaceChangeProposal(msg, idx, saved ? { ...rest, ...saved } : rest);
      trackChatProposal('research', discard ? 'discarded' : 'reopened', p.type.replace('research_', ''));
    } catch {
      this._setChangeError(msg, idx, app.t('recherche.chat.change.error.generic'));
    } finally {
      const next = { ...this._proposalSaving };
      delete next[k];
      this._proposalSaving = next;
    }
  },
};

// Zusätzlicher Karten-State dieses Moduls (in rechercheCard gespreadet).
export function researchChangeState() {
  return {
    // Text-Entwürfe je Änderungsvorschlag, Schlüssel `${msg.id}:${index}`.
    _changeEdits: {},
  };
}
