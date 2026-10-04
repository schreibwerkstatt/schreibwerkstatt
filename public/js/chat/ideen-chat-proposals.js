// Vorschläge des Ideen-Chats (context_info.proposals einer Assistant-Nachricht):
// Zustand, Anzeige und Übernehmen. Gespreadet in ideenBoardCard (über
// ideen-chat.js) — `this` ist das Ideen-Board, die Übernahme läuft über
// DIESELBEN /ideen-Routen wie jede Board-Bearbeitung (gleiche Server-
// Validierung: Stufen, Anker-Regeln, Buch-Prüfung). Jeder Vorschlag wird einzeln
// übernommen; ein „alle übernehmen" gibt es bewusst nicht.
//
// Persistierter Status (PATCH /ideen/chat-proposal): applied_at + applied_id bzw.
// status='discarded'. Transient am Vorschlagsobjekt: _applying, _error.
// Format der Vorschläge: routes/jobs/ideen-chat-tools.js (Kopfkommentar).
// Deep-Doc: docs/ideen-chat.md

import { fetchJson } from '../utils.js';
import { tFetchError } from '../i18n.js';
import { wordDiff } from './word-diff.js';
import { IDEE_OPEN_STATUSES } from '../book/ideen-shared.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function _find(ideen, id) {
  return id == null ? null : (ideen || []).find(i => i.id === id) || null;
}

/** id der Idee, die ein idee_ref liefert — nur wenn das referenzierte
 *  idee_create übernommen ist UND die Idee noch existiert. Sonst null. */
export function refAppliedIdeeId(proposals, ref, ideen) {
  const r = Array.isArray(proposals) ? proposals[ref - 1] : null;
  if (!r || r.type !== 'idee_create' || !r.applied_at) return null;
  return _find(ideen, r.applied_id) ? r.applied_id : null;
}

/**
 * Zustand eines Vorschlags gegen den aktuellen Board-Bestand. Pure (unit-getestet).
 * → { state: 'open'|'applied'|'discarded', removed, blocked: null|{ key, params }, stale }
 *   removed — übernommen, aber die angelegte Idee ist weg: wieder offen.
 *   blocked — offen, aber jetzt nicht übernehmbar (Idee weg, Bezugs-Idee noch nicht
 *             übernommen, Stufe abgeschaltet, Idee inzwischen abgeschlossen, schon verknüpft).
 *   stale   — Idee seit dem Vorschlag geändert (Hinweis, kein Block).
 */
export function ideenProposalStatus(p, proposals, ideen, stages = null) {
  const out = { state: 'open', removed: false, blocked: null, stale: false };
  if (!p) return out;
  if (p.applied_at) {
    if (p.type !== 'idee_create' || _find(ideen, p.applied_id)) { out.state = 'applied'; return out; }
    out.removed = true;
  } else if (p.status === 'discarded') {
    out.state = 'discarded';
    return out;
  }
  if (p.type === 'idee_update') {
    const idee = _find(ideen, p.idee_id);
    if (!idee) { out.blocked = { key: 'ideenBoard.chat.block.ideeGone' }; return out; }
    const f = p.fields || {};
    if (f.status && f.status !== idee.status && Array.isArray(stages) && !stages.includes(f.status)) {
      out.blocked = { key: 'ideenBoard.chat.block.stageInactive', params: { status: f.status } };
      return out;
    }
    if ((f.page_id || f.chapter_id) && !IDEE_OPEN_STATUSES.includes(idee.status)) {
      out.blocked = { key: 'ideenBoard.chat.block.closed' };
      return out;
    }
    const b = p.before || {};
    out.stale = Object.keys(b).some(k => (idee[k] ?? null) !== (b[k] ?? null));
    return out;
  }
  if (p.type === 'link_create') {
    let ideeId = p.idee_id;
    if (p.idee_ref) {
      ideeId = refAppliedIdeeId(proposals, p.idee_ref, ideen);
      if (!ideeId) {
        const ref = proposals?.[p.idee_ref - 1];
        out.blocked = { key: 'ideenBoard.chat.block.refIdee', params: { text: String(ref?.fields?.content || '').slice(0, 60) } };
        return out;
      }
    }
    const idee = _find(ideen, ideeId);
    if (!idee) { out.blocked = { key: 'ideenBoard.chat.block.ideeGone' }; return out; }
    if ((idee.links || []).some(l => l.target_kind === p.target_kind && l.target_id === p.target_id)) {
      out.blocked = { key: 'ideenBoard.chat.block.linkExists' };
    }
  }
  return out;
}

/**
 * Diff-Zeilen eines Änderungs-Vorschlags fürs Template. Pure.
 * → [{ key, before, after, diff? }]  diff = wordDiff-Teile für den Text
 */
export function ideeUpdateRows(p) {
  if (p?.type !== 'idee_update') return [];
  const f = p.fields || {};
  const b = p.before || {};
  const L = p.labels || {};
  const rows = [];
  if ('status' in f) rows.push({ key: 'status', before: b.status || '', after: f.status, status: true });
  if ('page_id' in f || 'chapter_id' in f) rows.push({ key: 'anchor', before: L.anchor_before || '', after: L.anchor || '' });
  if ('content' in f) {
    const before = String(b.content || '');
    const after = String(f.content || '');
    rows.push({ key: 'content', before, after, diff: wordDiff(before, after) });
  }
  return rows;
}

export const ideenProposalMethods = {
  ideenProposals(msg) {
    return Array.isArray(msg?.context_info?.proposals) ? msg.context_info.proposals : [];
  },

  ideenProposalStatus(msg, pi) {
    const list = this.ideenProposals(msg);
    return ideenProposalStatus(list[pi], list, this.ideen || [], this.stages);
  },

  ideenProposalRows(p) { return ideeUpdateRows(p); },

  ideenProposalTypeLabel(p) {
    return window.__app.t(`ideenBoard.chat.type.${p?.type || 'idee_create'}`);
  },

  // Blockier-Grund als Text (Status-Keys der Stufen übersetzt).
  ideenProposalBlockedText(msg, pi) {
    const b = this.ideenProposalStatus(msg, pi).blocked;
    if (!b) return '';
    const params = { ...(b.params || {}) };
    if (params.status) params.status = this.statusLabel(params.status);
    return window.__app.t(b.key, params);
  },

  ideenProposalLinkKind(p) {
    return window.__app.t(`ideen.link.kind.${p?.target_kind}`);
  },

  async _patchIdeenProposal(msg, pi, action, appliedId = null) {
    const res = await fetchJson('/ideen/chat-proposal', {
      method: 'PATCH', headers: JSON_HEADERS,
      body: JSON.stringify({ message_id: msg.id, index: pi, action, ...(appliedId ? { applied_id: appliedId } : {}) }),
    });
    const p = this.ideenProposals(msg)[pi];
    if (p && res?.proposal) {
      for (const k of ['applied_at', 'applied_id', 'status']) {
        if (k in res.proposal) p[k] = res.proposal[k]; else delete p[k];
      }
    }
  },

  async applyIdeenProposal(msg, pi) {
    const app = window.__app;
    const list = this.ideenProposals(msg);
    const p = list[pi];
    if (!p || p._applying || this.busy) return;
    const st = ideenProposalStatus(p, list, this.ideen || [], this.stages);
    if (st.state !== 'open' || st.blocked) return;
    p._applying = true;
    p._error = '';
    this.busy = true;
    let appliedId = null;
    try {
      appliedId = await this._applyIdeenProposalByType(p, list);
    } catch (e) {
      p._error = e?.body ? tFetchError(e) : app.t('ideenBoard.chat.applyError');
      p._applying = false;
      this.busy = false;
      return;
    }
    this.busy = false;
    this.errorMessage = '';
    this._memos = {};
    this._publishCounts();
    await this._ensureBoardSortables();
    try {
      await this._patchIdeenProposal(msg, pi, 'applied', appliedId);
    } catch {
      // Das Board ist geändert, nur der Status fehlt — sichtbar machen statt
      // verschlucken (ein Reload zeigte den Vorschlag sonst wieder offen).
      p._error = app.t('ideenBoard.chat.statusError');
    } finally { p._applying = false; }
  },

  async discardIdeenProposal(msg, pi, discard = true) {
    const p = this.ideenProposals(msg)[pi];
    if (!p || p._applying) return;
    p._error = '';
    try {
      await this._patchIdeenProposal(msg, pi, discard ? 'discarded' : 'reopen');
    } catch (e) {
      p._error = tFetchError(e);
    }
  },

  // Ein Schreibweg je Art, über die regulären /ideen-Routen. Wirft bei Fehler
  // (fetchJson) — die Server-Prüfung gilt unverändert.
  async _applyIdeenProposalByType(p, list) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (p.type === 'idee_create') {
      const f = p.fields || {};
      const row = await fetchJson('/ideen', {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({
          book_id: bookId, content: f.content,
          ...(f.page_id ? { page_id: f.page_id } : {}),
          ...(f.chapter_id ? { chapter_id: f.chapter_id } : {}),
        }),
      });
      this.ideen = [row, ...(this.ideen || [])];
      return row.id;
    }
    if (p.type === 'idee_update') {
      const f = p.fields || {};
      const body = {};
      for (const k of ['content', 'status', 'page_id', 'chapter_id']) if (k in f) body[k] = f[k];
      const row = await fetchJson(`/ideen/${p.idee_id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });
      this._replaceIdee(row);
      return p.idee_id;
    }
    if (p.type === 'link_create') {
      const ideeId = p.idee_ref ? refAppliedIdeeId(list, p.idee_ref, this.ideen) : p.idee_id;
      const row = await fetchJson(`/ideen/${ideeId}/links`, {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ target_kind: p.target_kind, target_id: p.target_id }),
      });
      this._replaceIdee(row);
      return ideeId;
    }
    throw new Error(`unknown proposal type ${p.type}`);
  },
};
