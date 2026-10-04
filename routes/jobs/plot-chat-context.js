'use strict';
// Kontext des Plot-Chats (routes/jobs/plot-chat.js), ohne Loop/KI unit-testbar:
//   loadBoardState      — Akte/Stränge/Beats + Namens-Maps eines (Buch, User)
//   boardOutline        — kompakte Text-Gliederung des Boards mit [#id]-Markern
//   figurenOutline      — Katalog- + Werkstatt-Figuren mit ihrer Referenz
//   sessionPlotProposalMemory — frühere Vorschläge der Session + ihr Status
//
// Das Board steht vollständig im System-Prompt, weil der Chat neben dem Board
// lebt und jeder Vorschlag ids braucht — eine Pflicht-Runde get_plot_board pro
// Frage wäre reine Verschwendung.

const { db } = require('../../db/schema');
const { listActs, listThreads, listBeats } = require('../../db/plot');
const { listDraftFigures } = require('../../db/draft-figures');
const { listFigureNamesForUser } = require('../../db/book-chat/figures');
const { ideaNotesByTarget } = require('../../lib/idea-context');

const DESC_PREVIEW = 300;

/**
 * Alles, was Outline und Vorschlags-Validierung brauchen, in einem Lesepfad.
 * `chapterNames` (Map id → Pfad) reicht der Aufrufer herein — Kapitel kommen
 * ausschliesslich über die Content-Store-Facade.
 */
function loadBoardState(bookId, userEmail, chapterNames = new Map()) {
  const acts = listActs(bookId, userEmail);
  const threads = listThreads(bookId, userEmail);
  const beats = listBeats(bookId, userEmail);
  const figures = listFigureNamesForUser(bookId, userEmail);
  const drafts = listDraftFigures(bookId, userEmail).map(d => ({ id: d.id, name: d.name }));
  return {
    acts, threads, beats, figures, drafts, chapterNames,
    actById: new Map(acts.map(a => [a.id, a])),
    threadById: new Map(threads.map(t => [t.id, t])),
    beatById: new Map(beats.map(b => [b.id, b])),
    figNameById: new Map(figures.map(f => [f.fig_id, f.name || f.kurzname || f.fig_id])),
    draftNameById: new Map(drafts.map(d => [d.id, d.name])),
    // Pendenzen des Autors je Beat (offen / verworfen) — siehe lib/idea-context.js.
    ideasByBeat: ideaNotesByTarget('beat', bookId, userEmail),
    ideasByThread: ideaNotesByTarget('thread', bookId, userEmail),
  };
}

function _actScopeLabel(act, state) {
  if (act.thread_id == null) return 'geteilt';
  const t = state.threadById.get(act.thread_id);
  return `nur Strang «${t?.name || '?'}» [#${act.thread_id}]`;
}

function _beatLine(b, state, ideenMarker) {
  const parts = [`[#${b.id}] «${b.titel}»`, b.status === 'im_buch' ? 'im Buch' : 'geplant'];
  if (b.verworfen) parts.push('VERWORFEN');
  if (b.thread_id != null) parts.push(`Strang «${state.threadById.get(b.thread_id)?.name || '?'}» [#${b.thread_id}]`);
  if (b.chapter_id) parts.push(`Kapitel «${state.chapterNames.get(b.chapter_id) || b.chapter_name || '?'}» [#${b.chapter_id}]`);
  if (b.intensitaet) parts.push(`Spannung ${b.intensitaet}`);
  if (b.zeit) parts.push(`Zeit «${b.zeit}»`);
  const figs = [
    ...(b.fig_ids || []).map(id => state.figNameById.get(id) || id),
    ...(b.draft_fig_ids || []).map(id => state.draftNameById.get(id)).filter(Boolean),
  ];
  if (figs.length) parts.push(`Figuren: ${figs.join(', ')}`);
  const lines = [`  - ${parts.join(' · ')}`];
  const desc = String(b.beschreibung || '').replace(/\s+/g, ' ').trim();
  if (desc) lines.push(`      ${desc.length > DESC_PREVIEW ? desc.slice(0, DESC_PREVIEW) + '…' : desc}`);
  const ideen = ideenMarker ? ideenMarker(state.ideasByBeat?.get(b.id)) : '';
  if (ideen) lines.push(`      ${ideen}`);
  return lines.join('\n');
}

/**
 * Board als Text. Reihenfolge = Board-Reihenfolge (Akt-Position je Bereich,
 * Beats je Zelle nach sort_order) — die Reihenfolge IST die Chronologie, nach der
 * das Modell Kausalität und Bögen beurteilt.
 */
function boardOutline(state, { ideenMarker = null } = {}) {
  if (!state.acts.length) return '';
  const out = [];
  if (state.threads.length) {
    out.push('STRÄNGE:');
    for (const t of state.threads) {
      const figur = t.fig_id ? state.figNameById.get(t.fig_id)
        : (t.draft_figure_id ? state.draftNameById.get(t.draft_figure_id) : null);
      const ideen = ideenMarker ? ideenMarker(state.ideasByThread?.get(t.id)) : '';
      out.push(`- [#${t.id}] «${t.name}»${figur ? ` · Hauptfigur ${figur}` : ''}${t.chapter_name ? ` · Kapitel «${t.chapter_name}»` : ''}${ideen ? ` ${ideen}` : ''}`);
    }
    out.push('');
  }
  // Geteilte Akte zuerst, danach die strang-eigenen je Strang — je nach position.
  const scopes = [null, ...state.threads.map(t => t.id)];
  for (const scope of scopes) {
    const acts = state.acts
      .filter(a => (a.thread_id ?? null) === scope)
      .sort((a, b) => a.position - b.position || a.id - b.id);
    for (const a of acts) {
      out.push(`AKT [#${a.id}] «${a.name}» (${_actScopeLabel(a, state)}${a.archiviert ? ', archiviert' : ''})`);
      const beats = state.beats
        .filter(b => b.act_id === a.id)
        .sort((x, y) => ((x.thread_id ?? -1) - (y.thread_id ?? -1)) || (x.sort_order - y.sort_order) || (x.id - y.id));
      if (!beats.length) out.push('  (keine Beats)');
      for (const b of beats) out.push(_beatLine(b, state, ideenMarker));
    }
  }
  return out.join('\n');
}

function figurenOutline(state) {
  const lines = [];
  for (const f of state.figures) {
    const name = f.name || f.kurzname || f.fig_id;
    lines.push(`- ${name}${f.kurzname && f.kurzname !== name ? ` (${f.kurzname})` : ''} · fig_id ${f.fig_id}`);
  }
  for (const d of state.drafts) lines.push(`- ${d.name} · Werkstatt-Figur (in Entwicklung)`);
  return lines.join('\n');
}

const PROPOSAL_TYPE_LABEL = {
  beat_create: 'neuer Beat', beat_update: 'Beat ändern', beat_move: 'Beat verschieben',
  act_create: 'neuer Akt', act_update: 'Akt umbenennen',
  thread_create: 'neuer Strang', thread_update: 'Strang ändern',
};

/** Anzeige-Titel eines gespeicherten Vorschlags (für Gedächtnis-Block + Logs). */
function proposalLabel(p) {
  if (!p || typeof p !== 'object') return '';
  if (p.type === 'beat_create') return p.fields?.titel || '';
  if (p.type === 'beat_update') return p.fields?.titel || p.labels?.beat || '';
  if (p.type === 'beat_move') return p.labels?.beat || '';
  if (p.type === 'act_create' || p.type === 'act_update') return p.name || '';
  if (p.type === 'thread_create') return p.name || '';
  if (p.type === 'thread_update') return p.fields?.name || p.labels?.thread || '';
  return '';
}

/** Status eines Vorschlags: applied / discarded / open. */
function proposalState(p) {
  if (p?.applied_at) return 'applied';
  if (p?.status === 'discarded') return 'discarded';
  return 'open';
}

/**
 * Frühere Vorschläge dieser Session, kompakt — für den Gedächtnis-Block im
 * System-Prompt („nimm den dritten", „nicht nochmal vorschlagen").
 */
function sessionPlotProposalMemory(sessionId, limit = 40) {
  const rows = db.prepare(
    `SELECT context_info FROM chat_messages
      WHERE session_id = ? AND role = 'assistant' AND context_info LIKE '%"proposals"%'
      ORDER BY created_at ASC, id ASC`
  ).all(sessionId);
  const out = [];
  for (const r of rows) {
    let ci;
    try { ci = JSON.parse(r.context_info); } catch { continue; }
    for (const p of Array.isArray(ci?.proposals) ? ci.proposals : []) {
      const label = proposalLabel(p);
      if (!label) continue;
      out.push({ type: PROPOSAL_TYPE_LABEL[p.type] || p.type, label: String(label).slice(0, 120), state: proposalState(p) });
    }
  }
  return out.slice(-limit);
}

module.exports = {
  loadBoardState, boardOutline, figurenOutline,
  sessionPlotProposalMemory, proposalLabel, proposalState, PROPOSAL_TYPE_LABEL,
};
