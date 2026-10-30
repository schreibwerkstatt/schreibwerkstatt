'use strict';
// Kontext des Plot-Chats (routes/jobs/plot-chat.js), ohne Loop/KI unit-testbar:
//   loadBoardState      — Akte/Stränge/Beats + Namens-Maps eines (Buch, User)
//   boardOutline        — kompakte Text-Gliederung des Boards mit [#id]-Markern
//   fitBoardOutline     — dieselbe Gliederung, aufs Zeichenbudget gekürzt
//   figurenOutline      — Katalog- + Werkstatt-Figuren, jede mit ihrer Kennung
//   sessionPlotProposalMemory — frühere Vorschläge der Session + ihr Status
//
// Das Board steht im Vorspann der Frage, weil der Chat neben dem Board lebt und
// jeder Vorschlag ids braucht — eine Pflicht-Runde get_plot_board pro Frage wäre
// reine Verschwendung. Bei grossen Boards wird es gekürzt (fitBoardOutline).

const { listActs, listThreads, listBeats } = require('../../db/plot');
const { listDraftFigures } = require('../../db/draft-figures');
const { listFigureNamesForUser } = require('../../db/book-chat/figures');
const { ideaNotesByTarget } = require('../../lib/idea-context');
const { laneReadingOrder } = require('../../lib/plot-reading-order');
const { sessionProposalMemory, proposalState: sharedProposalState } = require('./proposal-chat-shared');

// Beschreibungslänge je Kürzungsstufe (0 = keine Beschreibung).
const DESC_LEVELS = [300, 120, 0];

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

/** Hat der Strang eine eigene Aktstruktur (strang-eigene Akte)? */
function threadHasOwnActs(state, threadId) {
  return state.acts.some(a => a.thread_id != null && a.thread_id === threadId);
}

/**
 * Lesereihenfolge als Blöcke + Lane-Rang — aus der SSoT lib/plot-reading-order.js
 * (gleiche Regel wie prompts/plot/board.js#plotReadingBlocks der Analyse-Jobs):
 * Block 1 = geteilte Akte, danach je Strang mit eigener Aktstruktur ein Block.
 * Die Reihenfolge gilt nur INNERHALB eines Blocks.
 */
function readingBlocks(state) {
  const lanes = laneReadingOrder({ acts: state.acts, threads: state.threads, beats: [] });
  const none = lanes.find(l => l.threadId == null);
  const blocks = [{ threadId: null, acts: none ? none.acts : [] }];
  for (const l of lanes) {
    if (l.threadId != null && l.acts.some(a => a.thread_id === l.threadId)) blocks.push({ threadId: l.threadId, acts: l.acts });
  }
  // Akte eines Strangs, den die Strangliste nicht kennt — nie still verlieren.
  const seen = new Set(blocks.flatMap(b => b.acts.map(a => a.id)));
  const rest = state.acts.filter(a => !seen.has(a.id));
  if (rest.length) blocks.push({ threadId: rest[0].thread_id ?? null, acts: rest, orphan: true });
  const laneRank = new Map(lanes.map((l, i) => [l.threadId, i]));
  const noneRank = laneRank.get(null) ?? lanes.length;
  return { blocks, laneRank: (tid) => (tid != null && laneRank.has(tid) ? laneRank.get(tid) : noneRank) };
}

function _actScopeLabel(act, state) {
  if (act.thread_id == null) return 'geteilt';
  const t = state.threadById.get(act.thread_id);
  return `nur Strang «${t?.name || '?'}» [#${act.thread_id}]`;
}

function _beatLine(b, state, ideenMarker, descMax) {
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
  if (desc && descMax > 0) lines.push(`      ${desc.length > descMax ? desc.slice(0, descMax) + '…' : desc}`);
  const ideen = ideenMarker ? ideenMarker(state.ideasByBeat?.get(b.id)) : '';
  if (ideen) lines.push(`      ${ideen}`);
  return lines.join('\n');
}

/**
 * Board als Text, in Lesereihenfolge (lib/plot-reading-order.js): geteilte Akte,
 * danach je Strang mit eigener Aktstruktur ein eigener, beschrifteter Block.
 * Beats eines Akts nach Lane (Strang-Reihenfolge, «ohne Strang» zuletzt), dann
 * sort_order — sort_order gilt pro Zelle, Beats verschiedener Lanes haben keine
 * gemeinsame Reihenfolge.
 * @param {object} opts { ideenMarker, descMax (0 = ohne Beschreibung),
 *                        collapseVerworfen (verworfene Beats nur zählen) }
 */
function boardOutline(state, { ideenMarker = null, descMax = DESC_LEVELS[0], collapseVerworfen = false } = {}) {
  if (!state.acts.length) return '';
  const out = [];
  if (state.threads.length) {
    out.push('STRÄNGE:');
    for (const t of state.threads) {
      const figur = t.fig_id ? state.figNameById.get(t.fig_id)
        : (t.draft_figure_id ? state.draftNameById.get(t.draft_figure_id) : null);
      const ideen = ideenMarker ? ideenMarker(state.ideasByThread?.get(t.id)) : '';
      const own = threadHasOwnActs(state, t.id) ? ' · eigene Aktstruktur' : '';
      out.push(`- [#${t.id}] «${t.name}»${figur ? ` · Hauptfigur ${figur}` : ''}${t.chapter_name ? ` · Kapitel «${t.chapter_name}»` : ''}${own}${ideen ? ` ${ideen}` : ''}`);
    }
    out.push('');
  }
  const { blocks, laneRank } = readingBlocks(state);
  const headed = blocks.some(b => b.threadId != null);
  for (const bl of blocks) {
    if (headed) {
      if (bl.threadId == null) out.push('=== GETEILTE AKTE — gemeinsame Lesereihenfolge aller Stränge ohne eigene Akte ===');
      else {
        const name = state.threadById.get(bl.threadId)?.name || `#${bl.threadId}`;
        out.push(`=== STRANG «${name}» [#${bl.threadId}] — EIGENE AKTSTRUKTUR, eigene Lesereihenfolge ===`);
      }
    }
    for (const a of bl.acts) {
      out.push(`AKT [#${a.id}] «${a.name}» (${_actScopeLabel(a, state)}${a.archiviert ? ', archiviert' : ''})`);
      const all = state.beats
        .filter(b => b.act_id === a.id)
        .sort((x, y) => (laneRank(x.thread_id) - laneRank(y.thread_id)) || (x.sort_order - y.sort_order) || (x.id - y.id));
      const shown = collapseVerworfen ? all.filter(b => !b.verworfen) : all;
      if (!all.length) out.push('  (keine Beats)');
      for (const b of shown) out.push(_beatLine(b, state, ideenMarker, descMax));
      const hidden = all.length - shown.length;
      if (hidden) out.push(`  (+ ${hidden} verworfene${hidden === 1 ? 'r' : ''} Beat${hidden === 1 ? '' : 's'}, hier nicht aufgeführt)`);
    }
  }
  return out.join('\n');
}

/**
 * Board-Gliederung aufs Zeichenbudget: Stufe für Stufe kürzere Beschreibungen,
 * ab Stufe 2 verworfene Beats nur gezählt; reicht auch das nicht, harter Schnitt
 * mit Hinweis. → { text, trimmed } — `trimmed` steuert den Hinweis im Prompt.
 */
function fitBoardOutline(state, { ideenMarker = null, budgetChars = Infinity } = {}) {
  let text = '';
  for (let i = 0; i < DESC_LEVELS.length; i++) {
    text = boardOutline(state, { ideenMarker, descMax: DESC_LEVELS[i], collapseVerworfen: i > 0 });
    if (text.length <= budgetChars) return { text, trimmed: i > 0 };
  }
  const cut = text.slice(0, Math.max(0, budgetChars));
  return { text: `${cut.slice(0, cut.lastIndexOf('\n') > 0 ? cut.lastIndexOf('\n') : cut.length)}\n… (Board gekürzt — weitere Akte/Beats nicht aufgeführt)`, trimmed: true };
}

/** Katalog- und Werkstatt-Figuren — jede mit der Kennung, die propose_* annimmt. */
function figurenOutline(state) {
  const lines = [];
  for (const f of state.figures) {
    const name = f.name || f.kurzname || f.fig_id;
    lines.push(`- ${name}${f.kurzname && f.kurzname !== name ? ` (${f.kurzname})` : ''} · fig_id ${f.fig_id}`);
  }
  for (const d of state.drafts) lines.push(`- ${d.name} · Werkstatt-Figur draft#${d.id} (in Entwicklung)`);
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

const CREATE_MAP = { beat_create: 'beatById', act_create: 'actById', thread_create: 'threadById' };

/** Gibt es das von einem übernommenen create-Vorschlag Angelegte noch? undefined = kein create. */
function plotCreatedExists(state) {
  if (!state) return null;
  return (p) => {
    const map = CREATE_MAP[p?.type];
    if (!map) return undefined;
    return p.applied_id != null && state[map].has(p.applied_id);
  };
}

/** Status eines Vorschlags: applied / removed / discarded / open. */
function proposalState(p, state = null) {
  return sharedProposalState(p, plotCreatedExists(state));
}

/**
 * Frühere Vorschläge dieser Session, kompakt — mit `state` (Board-Stand) wird
 * ein übernommener, später rückgängig gemachter create-Vorschlag als solcher
 * erkannt.
 */
function sessionPlotProposalMemory(sessionId, state = null) {
  return sessionProposalMemory(sessionId, {
    label: proposalLabel, typeLabels: PROPOSAL_TYPE_LABEL, createdExists: plotCreatedExists(state),
  });
}

module.exports = {
  loadBoardState, boardOutline, fitBoardOutline, figurenOutline, readingBlocks, threadHasOwnActs,
  sessionPlotProposalMemory, proposalLabel, proposalState, PROPOSAL_TYPE_LABEL,
};
