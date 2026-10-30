'use strict';
// Kontext des Ideen-Chats (routes/jobs/ideen-chat.js), ohne Loop/KI unit-testbar:
//   loadIdeenState       — Ideen des Users, aktive Stufen, Gliederung, Link-Ziele
//   ideenOutline         — alle Ideen in Buch-Reihenfolge mit [#id]-Markern
//   fitIdeenOutline      — dieselbe Liste, aufs Zeichenbudget gekürzt
//   gliederungOutline    — Kapitel + Abschnitte mit ids (Ziel für Anker-Vorschläge)
//   targetsOutline       — verknüpfbare Ziele (Beat, Strang, Motiv, Werkstatt, Recherche)
//   sessionIdeenProposalMemory — frühere Vorschläge der Session + ihr Status
//
// Die Ideen stehen im Vorspann der Frage (bei vielen Ideen gekürzt), weil der Chat neben dem Board
// lebt und jeder Vorschlag eine Ideen-id braucht. Ideen sind user-privat
// (`ideen.user_email` ist Sichtbarkeits-Scope): jede Lesung hier trägt die
// E-Mail des Users — über db/ideen.js, das genau das erzwingt.

const { listBoardIdeen, listIdeaLinkTargets } = require('../../db/ideen');
const { getBookIdeenStages } = require('../../db/book-settings');
const { IDEA_LINK_KINDS, isOpenIdeeStatus } = require('../../lib/ideen-status');
const { listBookStatus } = require('../../db/redaktion');
const { sessionProposalMemory, proposalState: sharedProposalState, oneLine: _oneLine } = require('./proposal-chat-shared');

// Vorschau-Länge je Kürzungsstufe: offen / abgeschlossen; ab Stufe 2 stehen
// abgeschlossene Ideen nur noch als Zahl je Gruppe (fitIdeenOutline).
const PREVIEW_LEVELS = [{ open: 400, closed: 140 }, { open: 200, closed: 0 }, { open: 90, closed: 0 }];
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
    // Bearbeitungsstand je Abschnitt (docs/bearbeitungsstand.md) — steht an den
    // Abschnitten der Outlines, damit «final + offene Pendenz» auffaellt.
    editStatus: listBookStatus(bookId),
  };
}

// « — Stand: final (seither geändert)» oder leer.
function _standSuffix(state, pageId) {
  const e = state.editStatus?.[String(pageId)];
  if (!e?.status) return '';
  return ` — Stand: ${e.status}${e.stale ? ' (seither geändert)' : ''}`;
}

const LINK_KIND_LABEL = { research: 'Recherche', beat: 'Beat', thread: 'Strang', motif: 'Motiv', draft: 'Werkstatt-Figur' };

function _ideeLine(i, lvl = PREVIEW_LEVELS[0]) {
  const open = isOpenIdeeStatus(i.status);
  const parts = [`[#${i.id}] (${i.status})`, `«${_oneLine(i.content, open ? lvl.open : (lvl.closed || 140))}»`];
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
function ideenOutline(state, { level = 0 } = {}) {
  if (!state.ideen.length) return '';
  const lvl = PREVIEW_LEVELS[level] || PREVIEW_LEVELS[0];
  const collapseClosed = !lvl.closed;
  const out = [];
  const used = new Set();
  // Eine Gruppe: offene Ideen als Zeilen, abgeschlossene je nach Stufe als Zeilen
  // oder als Zahl («+ 3 abgeschlossen: erledigt 2, verworfen 1»).
  const emit = (list, indent) => {
    list.forEach(i => used.add(i.id));
    const shown = collapseClosed ? list.filter(i => isOpenIdeeStatus(i.status)) : list;
    shown.forEach(i => out.push(indent + _ideeLine(i, lvl)));
    const hidden = list.filter(i => !shown.includes(i));
    if (hidden.length) {
      const by = {};
      hidden.forEach(i => { by[i.status] = (by[i.status] || 0) + 1; });
      out.push(`${indent}  (+ ${hidden.length} abgeschlossen: ${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ')})`);
    }
  };

  const book = state.ideen.filter(i => i.page_id == null && i.chapter_id == null);
  if (book.length) {
    out.push('BUCH (ohne Ort im Text — Kandidaten für einen Anker):');
    emit(book, '');
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
    out.push(`${indent}ABSCHNITT [page#${p.id}] «${p.name}»${_standSuffix(state, p.id)}`);
    emit(list, indent);
  };
  for (const c of state.chaptersFlat) {
    const indent = '  '.repeat(state.chapterDepth.get(c.id) || 0);
    const own = state.ideen.filter(i => i.chapter_id === c.id);
    const pages = pagesByChapter.get(c.id) || [];
    const hasPageIdeen = pages.some(p => state.ideen.some(i => i.page_id === p.id));
    if (!own.length && !hasPageIdeen) continue;
    out.push(`${indent}KAPITEL [chapter#${c.id}] «${c.path || c.name}»`);
    emit(own, indent);
    pages.forEach(p => pageBlock(p, indent + '  '));
  }
  (pagesByChapter.get(null) || []).forEach(p => pageBlock(p, ''));
  const rest = state.ideen.filter(i => !used.has(i.id));
  if (rest.length) {
    out.push('OHNE BEKANNTE STELLE (Kapitel ausgeschlossen o.ä.):');
    emit(rest, '');
  }
  return out.join('\n');
}

/**
 * Ideenliste aufs Zeichenbudget: Stufe für Stufe kürzere Vorschau, ab Stufe 2
 * abgeschlossene Ideen nur gezählt; reicht auch das nicht, harter Schnitt mit
 * Hinweis. → { text, trimmed } — `trimmed` steuert den Hinweis im Prompt.
 */
function fitIdeenOutline(state, { budgetChars = Infinity } = {}) {
  let text = '';
  for (let level = 0; level < PREVIEW_LEVELS.length; level++) {
    text = ideenOutline(state, { level });
    if (text.length <= budgetChars) return { text, trimmed: level > 0 };
  }
  const cut = text.slice(0, Math.max(0, budgetChars));
  const nl = cut.lastIndexOf('\n');
  return { text: `${nl > 0 ? cut.slice(0, nl) : cut}\n… (Ideenliste gekürzt — weitere Ideen nicht aufgeführt)`, trimmed: true };
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
    for (const p of pagesByChapter.get(c.id) || []) out.push(`${indent}  · Abschnitt [page#${p.id}] «${p.name}»${_standSuffix(state, p.id)}`);
  }
  for (const p of pagesByChapter.get(null) || []) out.push(`- Abschnitt [page#${p.id}] «${p.name}» (ohne Kapitel)${_standSuffix(state, p.id)}`);
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
    else if ('page_id' in (p.fields || {})) what.push('→ Buch (Anker gelöst)');
    if (typeof p.fields?.content === 'string') what.push('Text');
    return `#${p.idee_id} «${_oneLine(p.labels?.idee, 60)}» ${what.join(', ')}`.trim();
  }
  if (p.type === 'link_create') return `${p.idee_id ? `#${p.idee_id}` : 'neue Idee'} ↔ ${p.labels?.target || p.target_kind}`;
  return '';
}

/** Gibt es die von einem übernommenen idee_create angelegte Idee noch? undefined = kein create. */
function ideenCreatedExists(state) {
  if (!state) return null;
  return (p) => (p?.type === 'idee_create' ? (p.applied_id != null && state.ideeById.has(p.applied_id)) : undefined);
}

/** Status eines Vorschlags: applied / removed / discarded / open. */
function proposalState(p, state = null) {
  return sharedProposalState(p, ideenCreatedExists(state));
}

/** Frühere Vorschläge dieser Session, kompakt — mit `state` wird eine übernommene,
 *  später gelöschte neue Idee als solche erkannt. */
function sessionIdeenProposalMemory(sessionId, state = null) {
  return sessionProposalMemory(sessionId, {
    label: proposalLabel, typeLabels: PROPOSAL_TYPE_LABEL, createdExists: ideenCreatedExists(state),
  });
}

module.exports = {
  loadIdeenState, ideenOutline, fitIdeenOutline, gliederungOutline, targetsOutline,
  sessionIdeenProposalMemory, proposalLabel, proposalState, PROPOSAL_TYPE_LABEL,
};
