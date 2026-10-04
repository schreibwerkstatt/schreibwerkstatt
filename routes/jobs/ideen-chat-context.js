'use strict';
// Kontext des Ideen-Chats (routes/jobs/ideen-chat.js), ohne Loop/KI unit-testbar:
//   loadIdeenState       — Ideen des Users, aktive Stufen, Gliederung, Link-Ziele
//   ideenOutline         — alle Ideen in Buch-Reihenfolge mit [#id]-Markern
//   gliederungOutline    — Kapitel + Abschnitte mit ids (Ziel für Anker-Vorschläge)
//   targetsOutline       — verknüpfbare Ziele (Beat, Strang, Motiv, Werkstatt, Recherche)
//   sessionIdeenProposalMemory — frühere Vorschläge der Session + ihr Status
//
// Die Ideen stehen vollständig im System-Prompt, weil der Chat neben dem Board
// lebt und jeder Vorschlag eine Ideen-id braucht. Ideen sind user-privat
// (`ideen.user_email` ist Sichtbarkeits-Scope): jede Lesung hier trägt die
// E-Mail des Users — über db/ideen.js, das genau das erzwingt.

const { db } = require('../../db/schema');
const { listBoardIdeen, listIdeaLinkTargets } = require('../../db/ideen');
const { getBookIdeenStages } = require('../../db/book-settings');
const { IDEA_LINK_KINDS, isOpenIdeeStatus } = require('../../lib/ideen-status');

const OPEN_PREVIEW = 400;
const CLOSED_PREVIEW = 140;
const MAX_TARGETS_PER_KIND = 80;

/**
 * Alles, was Outline und Vorschlags-Validierung brauchen. `tree` ist das Ergebnis
 * von loadOrderedBookContents (Content-Store-Facade) — Kapitel und Abschnitte
 * kommen ausschliesslich von dort.
 */
function loadIdeenState(bookId, userEmail, tree = {}) {
  const ideen = listBoardIdeen(bookId, userEmail);
  const chaptersFlat = tree.chaptersFlat || [];
  const pages = (tree.pages || []).map(p => ({ id: p.id, name: p.name || p.page_name || '', chapter_id: p.chapter_id ?? null }));
  const depthById = new Map();
  for (const c of chaptersFlat) depthById.set(c.id, c.parent_id ? (depthById.get(c.parent_id) || 0) + 1 : 0);
  return {
    ideen,
    stages: getBookIdeenStages(bookId),
    chaptersFlat,
    pages,
    targets: listIdeaLinkTargets(bookId, userEmail),
    ideeById: new Map(ideen.map(i => [i.id, i])),
    chapterNames: new Map(chaptersFlat.map(c => [c.id, c.path || c.name])),
    chapterDepth: depthById,
    pageById: new Map(pages.map(p => [p.id, p])),
  };
}

function _oneLine(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

const LINK_KIND_LABEL = { research: 'Recherche', beat: 'Beat', thread: 'Strang', motif: 'Motiv', draft: 'Werkstatt-Figur' };

function _ideeLine(i) {
  const open = isOpenIdeeStatus(i.status);
  const parts = [`[#${i.id}] (${i.status})`, `«${_oneLine(i.content, open ? OPEN_PREVIEW : CLOSED_PREVIEW)}»`];
  const links = (i.links || []).map(l => `${LINK_KIND_LABEL[l.target_kind] || l.target_kind} «${_oneLine(l.label, 60)}» [${l.target_kind}#${l.target_id}]`);
  if (links.length) parts.push(`verknüpft: ${links.join(', ')}`);
  return `  - ${parts.join(' · ')}`;
}

/**
 * Ideen als Text, gruppiert nach Anker in Buch-Reihenfolge: zuerst die Buch-Ideen
 * ohne Ort, dann je Kapitel seine eigenen Ideen und die seiner Abschnitte. Eine
 * Idee, deren Anker der Baum nicht kennt (ausgeschlossenes Kapitel, Abschnitt
 * ausserhalb), landet in einer Sammelgruppe — nie verschwindet eine still.
 */
function ideenOutline(state) {
  if (!state.ideen.length) return '';
  const out = [];
  const used = new Set();
  const take = (list) => list.forEach(i => used.add(i.id));

  const book = state.ideen.filter(i => i.page_id == null && i.chapter_id == null);
  if (book.length) {
    out.push('BUCH (ohne Ort im Text — Kandidaten für einen Anker):');
    book.forEach(i => out.push(_ideeLine(i)));
    take(book);
  }
  const pagesByChapter = new Map();
  for (const p of state.pages) {
    const k = p.chapter_id ?? null;
    if (!pagesByChapter.has(k)) pagesByChapter.set(k, []);
    pagesByChapter.get(k).push(p);
  }
  const pageBlock = (p, indent) => {
    const list = state.ideen.filter(i => i.page_id === p.id);
    if (!list.length) return;
    out.push(`${indent}ABSCHNITT [page#${p.id}] «${p.name}»`);
    list.forEach(i => out.push(indent + _ideeLine(i)));
    take(list);
  };
  for (const c of state.chaptersFlat) {
    const indent = '  '.repeat(state.chapterDepth.get(c.id) || 0);
    const own = state.ideen.filter(i => i.chapter_id === c.id);
    const pages = pagesByChapter.get(c.id) || [];
    const hasPageIdeen = pages.some(p => state.ideen.some(i => i.page_id === p.id));
    if (!own.length && !hasPageIdeen) continue;
    out.push(`${indent}KAPITEL [chapter#${c.id}] «${c.path || c.name}»`);
    own.forEach(i => out.push(indent + _ideeLine(i)));
    take(own);
    pages.forEach(p => pageBlock(p, indent + '  '));
  }
  (pagesByChapter.get(null) || []).forEach(p => pageBlock(p, ''));
  const rest = state.ideen.filter(i => !used.has(i.id));
  if (rest.length) {
    out.push('OHNE BEKANNTE STELLE (Kapitel ausgeschlossen o.ä.):');
    rest.forEach(i => out.push(_ideeLine(i)));
  }
  return out.join('\n');
}

/** Kapitel + Abschnitte mit ids — Ziele für Anker-Vorschläge und get_pages. */
function gliederungOutline(state) {
  const out = [];
  const pagesByChapter = new Map();
  for (const p of state.pages) {
    const k = p.chapter_id ?? null;
    if (!pagesByChapter.has(k)) pagesByChapter.set(k, []);
    pagesByChapter.get(k).push(p);
  }
  for (const c of state.chaptersFlat) {
    const indent = '  '.repeat(state.chapterDepth.get(c.id) || 0);
    out.push(`${indent}- Kapitel [chapter#${c.id}] «${c.name}»`);
    for (const p of pagesByChapter.get(c.id) || []) out.push(`${indent}  · Abschnitt [page#${p.id}] «${p.name}»`);
  }
  for (const p of pagesByChapter.get(null) || []) out.push(`- Abschnitt [page#${p.id}] «${p.name}» (ohne Kapitel)`);
  return out.join('\n');
}

/** Verknüpfbare Ziele je Art, gedeckelt — die Kappung wird ausgewiesen. */
function targetsOutline(state) {
  const out = [];
  for (const kind of IDEA_LINK_KINDS) {
    const list = state.targets?.[kind] || [];
    if (!list.length) continue;
    out.push(`${LINK_KIND_LABEL[kind] || kind} (target_kind "${kind}"):`);
    for (const t of list.slice(0, MAX_TARGETS_PER_KIND)) {
      out.push(`  - [${kind}#${t.id}] «${_oneLine(t.label, 80)}»${t.sublabel ? ` (${_oneLine(t.sublabel, 40)})` : ''}`);
    }
    if (list.length > MAX_TARGETS_PER_KIND) out.push(`  … ${list.length - MAX_TARGETS_PER_KIND} weitere nicht aufgeführt`);
  }
  return out.join('\n');
}

const PROPOSAL_TYPE_LABEL = { idee_create: 'neue Idee', idee_update: 'Idee ändern', link_create: 'Verknüpfung' };

/** Anzeige-Titel eines gespeicherten Vorschlags (Gedächtnis-Block + Logs). */
function proposalLabel(p) {
  if (!p || typeof p !== 'object') return '';
  if (p.type === 'idee_create') return p.fields?.content || '';
  if (p.type === 'idee_update') {
    const what = [];
    if (p.fields?.status) what.push(`→ ${p.fields.status}`);
    if (p.fields?.page_id || p.fields?.chapter_id) what.push(`→ ${p.labels?.anchor || 'Anker'}`);
    if (typeof p.fields?.content === 'string') what.push('Text');
    return `#${p.idee_id} «${_oneLine(p.labels?.idee, 60)}» ${what.join(', ')}`.trim();
  }
  if (p.type === 'link_create') return `${p.idee_id ? `#${p.idee_id}` : 'neue Idee'} ↔ ${p.labels?.target || p.target_kind}`;
  return '';
}

/** Status eines Vorschlags: applied / discarded / open. */
function proposalState(p) {
  if (p?.applied_at) return 'applied';
  if (p?.status === 'discarded') return 'discarded';
  return 'open';
}

/** Frühere Vorschläge dieser Session, kompakt — für den Gedächtnis-Block. */
function sessionIdeenProposalMemory(sessionId, limit = 40) {
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
      out.push({ type: PROPOSAL_TYPE_LABEL[p.type] || p.type, label: String(label).slice(0, 140), state: proposalState(p) });
    }
  }
  return out.slice(-limit);
}

module.exports = {
  loadIdeenState, ideenOutline, gliederungOutline, targetsOutline,
  sessionIdeenProposalMemory, proposalLabel, proposalState, PROPOSAL_TYPE_LABEL,
};
