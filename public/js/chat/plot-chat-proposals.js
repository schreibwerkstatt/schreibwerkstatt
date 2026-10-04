// Vorschläge des Plot-Chats (context_info.proposals einer Assistant-Nachricht):
// Zustand, Anzeige und Übernehmen. Gespreadet in plotCard (über plot-chat.js) —
// `this` ist die Plot-Karte, die Übernahme läuft über DIESELBEN /plot-Routen und
// Undo-Records wie jede Board-Bearbeitung (book/plot/history.js). Jeder Vorschlag
// wird einzeln übernommen; ein „alle übernehmen" gibt es bewusst nicht.
//
// Persistierter Status (PATCH /plot/chat-proposal): applied_at + applied_id bzw.
// status='discarded'. Transient am Vorschlagsobjekt: _applying, _error.
// Format der Vorschläge: routes/jobs/plot-chat-tools.js (Kopfkommentar).
// Deep-Doc: docs/plot-chat.md

import { fetchJson } from '../utils.js';
import { tFetchError } from '../i18n.js';
import { wordDiff } from './word-diff.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const CREATE_KIND = { beat_create: 'beat', act_create: 'act', thread_create: 'thread' };

function _exists(board, kind, id) {
  if (id == null) return false;
  const list = kind === 'beat' ? board.beats : kind === 'act' ? board.acts : board.threads;
  return (list || []).some(x => x.id === id);
}

// Ziel-Entität eines Änderungs-/Verschiebe-Vorschlags.
function _target(p) {
  if (p.type === 'beat_update' || p.type === 'beat_move') return { kind: 'beat', id: p.beat_id };
  if (p.type === 'act_update') return { kind: 'act', id: p.act_id };
  if (p.type === 'thread_update') return { kind: 'thread', id: p.thread_id };
  return null;
}

/** id, die ein act_ref/thread_ref liefert — nur wenn der referenzierte Vorschlag
 *  übernommen ist UND das Angelegte noch existiert. Sonst null. */
export function refAppliedId(proposals, ref, kind, board) {
  const r = Array.isArray(proposals) ? proposals[ref - 1] : null;
  if (!r || CREATE_KIND[r.type] !== kind || !r.applied_at) return null;
  return _exists(board, kind, r.applied_id) ? r.applied_id : null;
}

// Felder, die ein Beat-Vorschlag mit dem aktuellen Board vergleicht (Stale-Check).
function _beatValue(beat, k) {
  if (k === 'figure_ids') return [...(beat.fig_ids || [])].sort();
  if (k === 'draft_figure_ids') return [...(beat.draft_fig_ids || [])].sort();
  if (k === 'verworfen') return beat.verworfen ? 1 : 0;
  return beat[k] ?? null;
}
function _norm(k, v) {
  if (Array.isArray(v)) return JSON.stringify([...v].sort());
  if (k === 'beschreibung' || k === 'zeit') return JSON.stringify(v || null);
  return JSON.stringify(v ?? null);
}

/**
 * Zustand eines Vorschlags gegen das aktuelle Board. Pure (unit-getestet).
 * → { state: 'open'|'applied'|'discarded', removed, blocked: null|{ key, params },
 *     stale }
 *   removed — übernommen, aber das Angelegte ist nicht mehr da (Undo/gelöscht):
 *             wieder offen, erneut übernehmbar.
 *   blocked — offen, aber jetzt nicht übernehmbar (Ziel weg, Akt/Strang des
 *             Bezugs-Vorschlags noch nicht übernommen).
 *   stale   — Beat seit dem Vorschlag geändert (Hinweis, kein Block).
 */
export function proposalStatus(p, proposals, board) {
  const out = { state: 'open', removed: false, blocked: null, stale: false };
  if (!p) return out;
  const createKind = CREATE_KIND[p.type];
  if (p.applied_at) {
    if (!createKind || _exists(board, createKind, p.applied_id)) { out.state = 'applied'; return out; }
    out.removed = true;
  } else if (p.status === 'discarded') {
    out.state = 'discarded';
    return out;
  }
  const tgt = _target(p);
  if (tgt && !_exists(board, tgt.kind, tgt.id)) {
    out.blocked = { key: `plot.chat.block.${tgt.kind}Gone` };
    return out;
  }
  if (p.act_ref) {
    if (!refAppliedId(proposals, p.act_ref, 'act', board)) {
      out.blocked = { key: 'plot.chat.block.refAct', params: { name: proposals[p.act_ref - 1]?.name || '' } };
      return out;
    }
  } else if (p.act_id != null && (p.type === 'beat_create' || p.type === 'beat_move') && !_exists(board, 'act', p.act_id)) {
    out.blocked = { key: 'plot.chat.block.actGone' };
    return out;
  }
  if (p.thread_ref && !refAppliedId(proposals, p.thread_ref, 'thread', board)) {
    out.blocked = { key: 'plot.chat.block.refThread', params: { name: proposals[p.thread_ref - 1]?.name || '' } };
    return out;
  }
  if (p.thread_id != null && (p.type === 'beat_create' || p.type === 'beat_move' || p.type === 'act_create')
      && !_exists(board, 'thread', p.thread_id)) {
    out.blocked = { key: 'plot.chat.block.threadGone' };
    return out;
  }
  if (p.type === 'beat_update' && p.before) {
    const beat = (board.beats || []).find(b => b.id === p.beat_id);
    out.stale = Object.keys(p.before).some(k => _norm(k, _beatValue(beat, k)) !== _norm(k, p.before[k]));
  } else if (p.type === 'beat_move' && p.before) {
    const beat = (board.beats || []).find(b => b.id === p.beat_id);
    out.stale = beat.act_id !== p.before.act_id || (beat.thread_id ?? null) !== (p.before.thread_id ?? null);
  }
  return out;
}

/**
 * Diff-Zeilen eines Beat-Änderungs-Vorschlags fürs Template. Pure.
 * → [{ key, before, after, diff? }]  diff = wordDiff-Teile für Titel/Beschreibung
 */
export function beatUpdateRows(p) {
  if (p?.type !== 'beat_update') return [];
  const f = p.fields || {};
  const b = p.before || {};
  const L = p.labels || {};
  const rows = [];
  const text = (key) => {
    if (!(key in f)) return;
    const before = String(b[key] || '');
    const after = String(f[key] || '');
    rows.push({ key, before, after, diff: wordDiff(before, after) });
  };
  text('titel');
  text('beschreibung');
  if ('intensitaet' in f) rows.push({ key: 'intensitaet', before: b.intensitaet ?? '—', after: f.intensitaet ?? '—' });
  if ('zeit' in f) rows.push({ key: 'zeit', before: b.zeit || '—', after: f.zeit || '—' });
  if ('chapter_id' in f) rows.push({ key: 'chapter', before: L.chapter_before || '—', after: L.chapter || '—' });
  if ('figure_ids' in f || 'draft_figure_ids' in f) {
    rows.push({ key: 'figuren', before: (L.figuren_before || []).join(', ') || '—', after: (L.figuren || []).join(', ') || '—' });
  }
  if ('verworfen' in f) rows.push({ key: 'verworfen', flag: f.verworfen ? 'on' : 'off' });
  return rows;
}

// Neue Position eines Beats in seiner Zelle: hinter after_beat_id, an den Anfang
// oder (Default) ans Ende. Mutiert sort_order lokal; Aufrufer persistiert.
function _placeInCell(ctx, beatId, actId, threadId, { afterBeatId = null, atStart = false } = {}) {
  const list = ctx.beatsForCell(actId, threadId).filter(b => b.id !== beatId);
  const beat = (ctx.beats || []).find(b => b.id === beatId);
  if (!beat) return;
  let idx = list.length;
  if (atStart) idx = 0;
  else if (afterBeatId != null) {
    const i = list.findIndex(b => b.id === afterBeatId);
    if (i >= 0) idx = i + 1;
  }
  list.splice(idx, 0, beat);
  list.forEach((b, i) => { b.sort_order = i; });
}

export const plotProposalMethods = {
  plotProposals(msg) {
    return Array.isArray(msg?.context_info?.proposals) ? msg.context_info.proposals : [];
  },

  _plotBoardRef() {
    return { beats: this.beats || [], acts: this.acts || [], threads: this.threads || [] };
  },

  plotProposalStatus(msg, pi) {
    const list = this.plotProposals(msg);
    return proposalStatus(list[pi], list, this._plotBoardRef());
  },

  plotProposalRows(p) { return beatUpdateRows(p); },

  plotProposalTypeLabel(p) {
    return window.__app.t(`plot.chat.type.${p?.type || 'beat_create'}`);
  },

  // Positions-Hinweis eines neuen Beats/Akts bzw. Ziels einer Verschiebung.
  plotProposalWhere(p) {
    const t = (k, params) => window.__app.t(k, params);
    const L = p?.labels || {};
    const parts = [];
    if (p.type === 'beat_create' || p.type === 'beat_move') {
      if (L.act) parts.push(t('plot.chat.where.act', { name: L.act }));
      if (L.thread) parts.push(t('plot.chat.where.thread', { name: L.thread }));
      else if (p.thread_id === null && p.type === 'beat_move' && L.from_thread) parts.push(t('plot.chat.where.noThread'));
    }
    if (p.type === 'act_create' && L.thread) parts.push(t('plot.chat.where.thread', { name: L.thread }));
    if (L.after) parts.push(t('plot.chat.where.after', { name: L.after }));
    else if (p.at_start) parts.push(t('plot.chat.where.start'));
    return parts.join(' · ');
  },

  // Herkunft einer Verschiebung („aus Akt X · Strang Y").
  plotProposalFrom(p) {
    if (p?.type !== 'beat_move') return '';
    const t = (k, params) => window.__app.t(k, params);
    const L = p.labels || {};
    return [L.from_act ? t('plot.chat.where.act', { name: L.from_act }) : '',
      L.from_thread ? t('plot.chat.where.thread', { name: L.from_thread }) : ''].filter(Boolean).join(' · ');
  },

  // Ziel-Beat eines übernommenen Vorschlags (für „Im Board zeigen").
  plotProposalBeatId(p) {
    if (p?.type === 'beat_create') return p.applied_id || null;
    if (p?.type === 'beat_update' || p?.type === 'beat_move') return p.beat_id;
    return null;
  },

  showPlotProposalBeat(p) {
    const id = this.plotProposalBeatId(p);
    if (id) this.scrollToBeat(id);
  },

  async _patchPlotProposal(msg, pi, action, appliedId = null) {
    const res = await fetchJson('/plot/chat-proposal', {
      method: 'PATCH', headers: JSON_HEADERS,
      body: JSON.stringify({ message_id: msg.id, index: pi, action, ...(appliedId ? { applied_id: appliedId } : {}) }),
    });
    const p = this.plotProposals(msg)[pi];
    if (p && res?.proposal) {
      for (const k of ['applied_at', 'applied_id', 'status']) {
        if (k in res.proposal) p[k] = res.proposal[k]; else delete p[k];
      }
    }
  },

  async applyPlotProposal(msg, pi) {
    const app = window.__app;
    const list = this.plotProposals(msg);
    const p = list[pi];
    if (!p || p._applying || this.busy || this._inHistoryFlight) return;
    const st = proposalStatus(p, list, this._plotBoardRef());
    if (st.state !== 'open' || st.blocked) return;
    // Ein offenes Beat-Edit-Panel committet sonst per click.outside über die Übernahme.
    if (this.editingBeatId != null) this.cancelEditBeat();
    p._applying = true;
    p._error = '';
    this.busy = true;
    let appliedId = null;
    try {
      appliedId = await this._applyPlotProposalByType(p, list);
    } catch (e) {
      p._error = e?.body ? tFetchError(e) : app.t('plot.chat.applyError');
      p._applying = false;
      this.busy = false;
      return;
    }
    this.busy = false;
    this.errorMessage = '';
    try {
      await this._patchPlotProposal(msg, pi, 'applied', appliedId);
    } catch (e) {
      // Das Board ist geändert, nur der Status fehlt — sichtbar machen statt
      // verschlucken (ein Reload zeigte den Vorschlag sonst wieder offen).
      p._error = app.t('plot.chat.statusError');
    } finally { p._applying = false; }
  },

  async discardPlotProposal(msg, pi, discard = true) {
    const p = this.plotProposals(msg)[pi];
    if (!p || p._applying) return;
    p._error = '';
    try {
      await this._patchPlotProposal(msg, pi, discard ? 'discarded' : 'reopen');
    } catch (e) {
      p._error = tFetchError(e);
    }
  },

  async _applyPlotProposalByType(p, list) {
    const board = this._plotBoardRef();
    const bookId = Alpine.store('nav').selectedBookId;
    const actId = p.act_ref ? refAppliedId(list, p.act_ref, 'act', board) : p.act_id;
    const threadId = p.thread_ref ? refAppliedId(list, p.thread_ref, 'thread', board) : (p.thread_id ?? null);

    if (p.type === 'beat_create') {
      const beat = await fetchJson('/plot/beats', {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ book_id: bookId, act_id: actId, thread_id: threadId, ...p.fields }),
      });
      this.beats = [...this.beats, beat];
      this._memos = {};
      this._recordCreate('beat', beat.id);
      if (p.after_beat_id || p.at_start) {
        _placeInCell(this, beat.id, actId, threadId, { afterBeatId: p.after_beat_id, atStart: p.at_start });
        this.beats = [...this.beats];
        this._memos = {};
        await this._persistCells([{ actId, threadId }]);
      }
      window.__app.refreshPlotBeatCounts?.();
      this.loadTimeChecks();
      this.$nextTick(() => this.scrollToBeat(beat.id));
      return beat.id;
    }

    if (p.type === 'beat_update') {
      const beat = this.beats.find(b => b.id === p.beat_id);
      const snap = this._beatFieldSnapshot(beat);
      const before = {};
      for (const k of Object.keys(p.fields)) {
        before[k] = k === 'verworfen' ? (beat.verworfen ? 1 : 0) : snap[k];
      }
      const updated = await fetchJson(`/plot/beats/${p.beat_id}`, {
        method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(p.fields),
      });
      this._replaceBeat({ ...updated, occ_count: beat.occ_count, occ_top: beat.occ_top });
      this._recordBeatFields(p.beat_id, before, { ...p.fields });
      window.__app.refreshPlotBeatCounts?.();
      this.$nextTick(() => this.scrollToBeat(p.beat_id));
      return p.beat_id;
    }

    if (p.type === 'beat_move') {
      const beat = this.beats.find(b => b.id === p.beat_id);
      const placeBefore = this._snapshotPlacements();
      const fromCell = { actId: beat.act_id, threadId: beat.thread_id ?? null };
      beat.act_id = actId;
      beat.thread_id = threadId;
      _placeInCell(this, beat.id, actId, threadId, { afterBeatId: p.after_beat_id, atStart: p.at_start });
      this.beats
        .filter(b => b.act_id === fromCell.actId && (b.thread_id ?? null) === fromCell.threadId && b.id !== beat.id)
        .sort((a, b) => a.sort_order - b.sort_order)
        .forEach((b, i) => { b.sort_order = i; });
      this.beats = [...this.beats];
      this._memos = {};
      const same = fromCell.actId === actId && fromCell.threadId === threadId;
      const ok = await this._persistCells(same ? [{ actId, threadId }] : [fromCell, { actId, threadId }]);
      if (!ok) throw new Error('persist');
      this._recordBeatPlace(placeBefore);
      this.$nextTick(() => this.scrollToBeat(beat.id));
      return beat.id;
    }

    if (p.type === 'act_create') {
      const act = await fetchJson('/plot/acts', {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ book_id: bookId, name: p.name, thread_id: threadId }),
      });
      this.acts = [...this.acts, act];
      this._memos = {};
      this._recordCreate('act', act.id);
      // Der Akt existiert ab hier — scheitert nur die Platzierung, gilt der
      // Vorschlag trotzdem als übernommen (sonst legte ein zweiter Klick einen
      // zweiten Akt an). Die lokal umnummerierten Positionen wären dann nicht
      // persistiert: Board neu laden (leert auch die Historie).
      if (p.after_act_id || p.at_start) {
        try { await this._placePlotAct(act, p); } catch { await this.loadBoard(); }
      }
      return act.id;
    }

    if (p.type === 'act_update') {
      const act = this.acts.find(a => a.id === p.act_id);
      const updated = await fetchJson(`/plot/acts/${p.act_id}`, {
        method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name: p.name }),
      });
      this.acts = this.acts.map(a => (a.id === updated.id ? updated : a));
      this._memos = {};
      this._recordActFields(p.act_id, { name: act.name }, { name: p.name });
      return p.act_id;
    }

    if (p.type === 'thread_create') {
      const thread = await fetchJson('/plot/threads', {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({
          book_id: bookId, name: p.name,
          ...(p.figure_id ? { figure_id: p.figure_id } : {}),
          ...(p.draft_figure_id ? { draft_figure_id: p.draft_figure_id } : {}),
        }),
      });
      this.threads = [...this.threads, thread];
      this._memos = {};
      this._recordCreate('thread', thread.id);
      return thread.id;
    }

    if (p.type === 'thread_update') {
      const t = this.threads.find(x => x.id === p.thread_id);
      const before = {};
      for (const k of Object.keys(p.fields)) {
        before[k] = k === 'figure_id' ? (t.fig_id || null) : (t[k] ?? null);
      }
      const updated = await fetchJson(`/plot/threads/${p.thread_id}`, {
        method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(p.fields),
      });
      this.threads = this.threads.map(x => (x.id === updated.id ? updated : x));
      this._memos = {};
      this._recordThreadFields(p.thread_id, before, { ...p.fields });
      return p.thread_id;
    }
    throw new Error(`unknown proposal type ${p.type}`);
  },

  // Neuen Akt hinter after_act_id bzw. an den Anfang seines Bereichs stellen.
  // Nicht als eigener Undo-Record: das Undo des Anlegens entfernt den Akt samt
  // seinem Platz in der Reihenfolge.
  async _placePlotAct(act, p) {
    const scope = act.thread_id ?? null;
    const ordered = this.acts
      .filter(a => (a.thread_id ?? null) === scope && a.id !== act.id)
      .sort((a, b) => a.position - b.position);
    let idx = ordered.length;
    if (p.at_start) idx = 0;
    else if (p.after_act_id) {
      const i = ordered.findIndex(a => a.id === p.after_act_id);
      if (i >= 0) idx = i + 1;
    }
    ordered.splice(idx, 0, act);
    ordered.forEach((a, i) => { a.position = i; });
    const byId = new Map(ordered.map(a => [a.id, a]));
    this.acts = this.acts.map(a => byId.get(a.id) || a);
    this._memos = {};
    await fetchJson('/plot/acts/order', {
      method: 'PUT', headers: JSON_HEADERS,
      body: JSON.stringify({ book_id: Alpine.store('nav').selectedBookId, order: ordered.map(a => a.id) }),
    });
  },
};
