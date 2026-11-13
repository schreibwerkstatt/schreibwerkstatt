// Vorschläge des Ideen-Chats (context_info.proposals einer Assistant-Nachricht):
// Zustand, Anzeige und Übernehmen. Gespreadet in ideenBoardCard (über
// ideen-chat.js) — `this` ist das Ideen-Board, die Übernahme läuft über
// DIESELBEN /ideen-Routen wie jede Board-Bearbeitung (gleiche Server-
// Validierung: Stufen, Anker-Regeln, Buch-Prüfung). Jeder Vorschlag wird einzeln
// übernommen; ein „alle übernehmen" gibt es bewusst nicht.
//
// Persistierter Status (PATCH /ideen/chat-proposal): applied_at + applied_id bzw.
// status='discarded'. Transient am Vorschlagsobjekt: _applying, _error,
// _written/_appliedId (Board geschrieben, Status noch nicht —
// proposal-status.js#applyProposalOnce) und _belegMissing (der Beleg eines
// «erledigt» stand beim Übernehmen nicht mehr im Abschnitt).
// Format der Vorschläge: routes/jobs/ideen-chat-tools.js (Kopfkommentar).
// Deep-Doc: docs/ideen-chat.md

import { sendJson } from '../utils.js';
import { tFetchError } from '../i18n.js';
import { diffParts } from '../diff/diff-parts.js';
import { persistProposalStatus, applyProposalOnce, proposalApplyError } from './proposal-status.js';
import { trackChatProposal } from '../features-usage.js';
import { IDEE_OPEN_STATUSES } from '../book/ideen-shared.js';

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
    // Ortswechsel und Anker lösen (page_id = chapter_id = null) nur für offene Ideen.
    if (('page_id' in f || 'chapter_id' in f) && !IDEE_OPEN_STATUSES.includes(idee.status)) {
      out.blocked = { key: 'ideenBoard.chat.block.closed' };
      return out;
    }
    const b = p.before || {};
    out.stale = Object.keys(b).some(k => (idee[k] ?? null) !== (b[k] ?? null));
    return out;
  }
  if (p.type === 'idee_merge') {
    const keep = _find(ideen, p.idee_id);
    if (!keep) { out.blocked = { key: 'ideenBoard.chat.block.ideeGone' }; return out; }
    const sources = (p.merge_ids || []).map(id => _find(ideen, id));
    if (sources.some(s => !s)) { out.blocked = { key: 'ideenBoard.chat.block.mergeGone' }; return out; }
    if (!IDEE_OPEN_STATUSES.includes(keep.status) && sources.some(s => IDEE_OPEN_STATUSES.includes(s.status))) {
      out.blocked = { key: 'ideenBoard.chat.block.mergeClosed' };
      return out;
    }
    // Die aufgehenden Ideen werden gelöscht: wurde eine seit dem Vorschlag
    // geändert, ginge der neue Text verloren — neu vorschlagen lassen statt still löschen.
    const srcBefore = p.before?.sources;
    if (srcBefore && sources.some(s => (s.content ?? null) !== (srcBefore[s.id] ?? null))) {
      out.blocked = { key: 'ideenBoard.chat.block.mergeSourceChanged' };
      return out;
    }
    out.stale = (keep.content ?? null) !== (p.before?.content ?? null);
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
 * → [{ key, before, after, diff? }]  diff = markierte Wort-Diff-Teile (diff/diff-parts.js) für den Text
 */
export function ideeUpdateRows(p) {
  if (p?.type === 'idee_merge') {
    if (!('content' in (p.fields || {}))) return [];
    const before = String(p.before?.content || '');
    const after = String(p.fields.content || '');
    return [{ key: 'content', before, after, diff: diffParts(before, after) }];
  }
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
    rows.push({ key: 'content', before, after, diff: diffParts(before, after) });
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

  async applyIdeenProposal(msg, pi) {
    const app = window.__app;
    const list = this.ideenProposals(msg);
    const p = list[pi];
    if (!p || p._applying || this.busy) return;
    const st = ideenProposalStatus(p, list, this.ideen || [], this.stages);
    if (st.state !== 'open' || (st.blocked && !p._written)) return;
    p._applying = true;
    p._error = '';
    try {
      // «erledigt» steht auf einem Beleg aus dem Text DES VORSCHLAGS-ZEITPUNKTS —
      // vor dem Übernehmen gegen den aktuellen Abschnitt prüfen (Server, gleiche
      // Normalisierung wie beim Vorschlagen). Fehlt er, nur nach Rückfrage.
      if (!p._written && !(await this._confirmIdeenBeleg(msg, pi, p))) return;
      // Zusammenführen löscht die aufgehenden Ideen — einmal ausdrücklich bestätigen.
      if (!p._written && p.type === 'idee_merge' && !(await app.appConfirm({
        message: app.tn('ideenBoard.chat.mergeConfirm', (p.merge_ids || []).length),
        confirmLabel: app.t('ideenBoard.chat.mergeConfirmLabel'),
        danger: true,
      }))) return;
      this.busy = true;
      let writtenId = null;
      const r = await applyProposalOnce('/ideen/chat-proposal', msg, pi, async () => {
        const id = await this._applyIdeenProposalByType(p, list);
        writtenId = id;
        this.busy = false;
        this.errorMessage = '';
        this._memos = {};
        this._publishCounts();
        await this._ensureBoardSortables();
        return id;
      });
      // Neue oder umgehängte Idee sofort im Board zeigen — auch wenn ein Filter
      // oder eine eingeklappte Bahn sie verdecken würde. Gilt, sobald das Board
      // geschrieben ist, auch wenn danach nur der Status-PATCH scheitert.
      const f = p.fields || {};
      if (writtenId != null && (p.type === 'idee_create' || (p.type === 'idee_update' && ('page_id' in f || 'chapter_id' in f)))) {
        await this.revealIdee(writtenId);
      }
      if (r.ok) { if (!r.already) trackChatProposal('ideen', 'applied', p.type); return; }
      const err = proposalApplyError(r, { applyKey: 'ideenBoard.chat.applyError', statusKey: 'ideenBoard.chat.statusError' });
      if (err) p._error = err;
    } finally {
      this.busy = false;
      p._applying = false;
    }
  },

  // → true = übernehmen. Prüft den Beleg eines «erledigt»-Vorschlags gegen den
  // aktuellen Abschnittstext; fehlt er, markiert den Vorschlag (_belegMissing)
  // und fragt nach. Ein Prüf-Fehler (offline, Server) bricht ab, statt
  // ungeprüft zu übernehmen.
  async _confirmIdeenBeleg(msg, pi, p) {
    // Gilt für jeden Beleg — «erledigt» wie «verworfen» stützen sich auf eine Textstelle.
    if (p.type !== 'idee_update' || !p.beleg?.text) return true;
    const app = window.__app;
    let r;
    try {
      r = await sendJson('/ideen/chat-proposal/beleg-check', 'POST', { message_id: msg.id, index: pi });
    } catch (e) {
      p._error = tFetchError(e);
      return false;
    }
    p._belegMissing = r?.checked === true && r.found === false;
    if (!p._belegMissing) return true;
    return !!(await app.appConfirm({
      message: app.t('ideenBoard.chat.belegGoneConfirm', { status: this.statusLabel(p.fields?.status || 'erledigt') }),
    }));
  },

  async discardIdeenProposal(msg, pi, discard = true) {
    const p = this.ideenProposals(msg)[pi];
    if (!p || p._applying) return;
    p._error = '';
    try {
      await persistProposalStatus('/ideen/chat-proposal', msg, pi, discard ? 'discarded' : 'reopen');
      trackChatProposal('ideen', discard ? 'discarded' : 'reopened', p.type);
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
      const row = await sendJson('/ideen', 'POST', {
          book_id: bookId, content: f.content,
          ...(f.page_id ? { page_id: f.page_id } : {}),
          ...(f.chapter_id ? { chapter_id: f.chapter_id } : {}),
        });
      this.ideen = [row, ...(this.ideen || [])];
      return row.id;
    }
    if (p.type === 'idee_update') {
      const f = p.fields || {};
      const body = {};
      for (const k of ['content', 'status', 'page_id', 'chapter_id']) if (k in f) body[k] = f[k];
      const row = await sendJson(`/ideen/${p.idee_id}`, 'PATCH', body);
      this._replaceIdee(row);
      return p.idee_id;
    }
    if (p.type === 'idee_merge') {
      const f = p.fields || {};
      const r = await sendJson(`/ideen/${p.idee_id}/merge`, 'POST', { source_ids: p.merge_ids, ...('content' in f ? { content: f.content } : {}) });
      const removed = new Set(r.removed_ids || []);
      this.ideen = (this.ideen || []).filter(i => !removed.has(i.id));
      this._replaceIdee(r.idee);
      return p.idee_id;
    }
    if (p.type === 'link_create') {
      const ideeId = p.idee_ref ? refAppliedIdeeId(list, p.idee_ref, this.ideen) : p.idee_id;
      const row = await sendJson(`/ideen/${ideeId}/links`, 'POST', { target_kind: p.target_kind, target_id: p.target_id });
      this._replaceIdee(row);
      return ideeId;
    }
    throw new Error(`unknown proposal type ${p.type}`);
  },
};
