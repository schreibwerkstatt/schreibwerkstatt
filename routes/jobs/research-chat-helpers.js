'use strict';
// Reine Hilfen des Recherche-Chats (routes/jobs/research-chat.js), ausgelagert
// damit sie ohne Loop/KI unit-testbar sind:
//   toolsForRound          — Werkzeugliste unter dem Web-Such-Gesamtdeckel
//   validateAnswerSources  — `final_answer.quellen` gegen die Web-Treffer des Jobs
//   sessionProposalMemory  — frühere Vorschläge der Session (für den System-Prompt)
//   proposalsOnlyFallback  — Antworttext, wenn nur Vorschläge, aber kein Text kamen

const { db } = require('../../db/schema');
const { normalizeUrl } = require('../../lib/url-normalize');
const { cleanStr, TITLE_MAX } = require('../../lib/research-validate');
const { resolvePageBookId, resolveChapterBookId } = require('../../lib/content-ownership');
const contentStore = require('../../lib/content-store');
const { itemIdsAtPlace } = require('../../db/research-items');
const { htmlToTextForPrompt } = require('./shared');

/**
 * Werkzeugliste unter dem Web-Such-Gesamtdeckel: `max_uses` des serverseitigen
 * `web_search` höchstens der Rest des Deckels, bei aufgebrauchtem Deckel fällt das
 * Werkzeug weg. Der Recherche-Chat ruft das einmal beim Start — die Liste bleibt
 * danach für den ganzen Lauf gleich, weil Werkzeuge vorn im Prompt-Cache stehen und
 * Thinking-Blöcke an den unveränderten Gesprächsanfang gebunden sind. Den Deckel
 * über die Runden hält der Loop-Hook `stopBeforeRound` (Synthese statt weiterer
 * Runde); eine Runde kann ihn darum um höchstens den Rundenwert überschreiten.
 *
 * @param {Array} tools  Basisliste (mit `web_search`, `max_uses` = Rundenwert)
 * @param {number} used  bisher gelaufene Web-Suchen
 * @param {number} cap   Gesamtdeckel (jobs.research_chat.max_web_searches)
 */
function toolsForRound(tools, used, cap) {
  const remaining = Math.max(0, (Number(cap) || 0) - (Number(used) || 0));
  const out = [];
  for (const t of tools) {
    if (t.name !== 'web_search') { out.push(t); continue; }
    if (remaining <= 0) continue;
    const perRound = Number(t.max_uses) || remaining;
    out.push(perRound <= remaining ? t : { ...t, max_uses: remaining });
  }
  return out;
}

/**
 * `final_answer.quellen` (vom Modell benannt) gegen die tatsächlich in DIESEM Job
 * gefundenen Web-Treffer prüfen. Was nicht unter den Treffern ist, fällt weg — das
 * Modell darf keine URL als Beleg ausgeben, die es nie gesehen hat.
 * Vergleich über lib/url-normalize (Tracking-Parameter, www., Trailing-Slash).
 *
 * @param {Array} raw         [{ url, titel? }] aus dem Tool-Input
 * @param {Array} webResults  [{ url, title }] in Auftrittsreihenfolge (1-basiert referenziert)
 * @param {object} [opts]     `extra`: weitere in diesem Lauf gesehene Treffer (Literatur-Register)
 * @returns {Array<{url,title,doc_nums:number[]}>} doc_nums = Positionen dieser URL
 *   unter den Treffern; das Frontend ordnet `(cite index="N-…">`-Marker darüber zu.
 */
function validateAnswerSources(raw, webResults, { max = 20, extra = [] } = {}) {
  const web = Array.isArray(webResults) ? webResults : [];
  const more = Array.isArray(extra) ? extra : [];
  if (!Array.isArray(raw) || !raw.length || (!web.length && !more.length)) return [];
  const byNorm = new Map();
  web.forEach((r, i) => {
    const n = normalizeUrl(r?.url);
    if (!n) return;
    let e = byNorm.get(n);
    if (!e) { e = { url: r.url, title: r.title || r.url, doc_nums: [] }; byNorm.set(n, e); }
    e.doc_nums.push(i + 1);
  });
  // `extra`: in diesem Lauf gesehene Register-Treffer (lookup_literature). Sie
  // sind belegt, haben aber keine Position unter den Web-Treffern → doc_nums leer
  // (kein cite-Marker zeigt auf sie).
  for (const r of more) {
    const n = normalizeUrl(r?.url);
    if (n && !byNorm.has(n)) byNorm.set(n, { url: r.url, title: r.title || r.url, doc_nums: [] });
  }
  const out = [];
  const seen = new Set();
  for (const q of raw) {
    const n = normalizeUrl(typeof q === 'string' ? q : q?.url);
    if (!n || seen.has(n)) continue;
    const hit = byNorm.get(n);
    if (!hit) continue;
    seen.add(n);
    const titel = typeof q === 'object' ? cleanStr(q?.titel ?? q?.title, TITLE_MAX) : null;
    out.push({ url: hit.url, title: titel || hit.title, doc_nums: hit.doc_nums });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Frühere Speicher-Vorschläge dieser Session, kompakt — Titel, Typ und ob sie
 * gespeichert wurden (`saved_item_id`, nachgetragen von POST /research/chat-proposal).
 * Geht als Block in den System-Prompt, damit Folge-Turns sie nicht erneut
 * vorschlagen und „speicher das zweite" verstehen.
 */
function sessionProposalMemory(sessionId, limit = 30) {
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
      const title = p.title || p.urls?.[0]?.url || String(p.body || '').replace(/\s+/g, ' ').slice(0, 60);
      if (!title) continue;
      out.push({
        title: String(title).slice(0, 120),
        kind: p.kind || 'note',
        saved_item_id: p.saved_item_id || null,
        exists_item_id: p.exists_item_id || null,
      });
    }
  }
  return out.slice(-limit);
}

// Platzhalter des Loops für „keine Antwort" (agentic-chat.js) — mit Vorschlägen
// ist das kein Fehlschlag. Frontend-Pendant: research-chat-render.js.
const EMPTY_MARKERS = new Set(['__i18n:chat.errors.maxIterReached__', '__i18n:chat.errors.emptyAnswer__']);

/** Antworttext ohne Inhalt, aber mit Vorschlägen → eigener Hinweis statt
 *  „Iterationen erschöpft" (der Lauf war erfolgreich, nur ohne Prosa). */
function proposalsOnlyFallback(antwort, proposalCount) {
  const a = String(antwort || '').trim();
  if (proposalCount > 0 && (!a || EMPTY_MARKERS.has(a))) {
    return '__i18n:recherche.chat.proposalsOnly__';
  }
  return a;
}

// ── Schreibkontext der Frage (Kontext-Chip) ──────────────────────────────────
// Der Chip „Für Seite/Kapitel … recherchieren" schickt `{ kind, id }` mit der
// Frage. Geprueft gegen das Buch der Session (eine fremde Seite waere ein Weg,
// Text eines anderen Buchs in den Prompt zu ziehen) und an der User-Nachricht
// als context_info.research_context abgelegt — der Job liest es dort.
function researchMessageContext(raw, bookId) {
  const kind = raw?.kind === 'page' || raw?.kind === 'chapter' ? raw.kind : null;
  const id = parseInt(raw?.id, 10);
  if (!kind || !id || !bookId) return null;
  const owner = kind === 'page' ? resolvePageBookId(id) : resolveChapterBookId(id);
  return owner === bookId ? { research_context: { kind, id } } : null;
}

function readMessageContext(userMsgId) {
  if (!userMsgId) return null;
  const row = db.prepare('SELECT context_info FROM chat_messages WHERE id = ?').get(userMsgId);
  try { return JSON.parse(row?.context_info || 'null')?.research_context || null; } catch { return null; }
}

// Auszug-Deckel: genug, damit das Modell weiss, wovon die Szene handelt und
// welche Zeit/welcher Ort gemeint ist — kein Volltext (der Chat schreibt keinen
// Manuskripttext und braucht den Wortlaut nicht).
const CONTEXT_EXCERPT_MAX = 2500;
const CONTEXT_CHAPTER_PAGES = 4;
const CONTEXT_ITEMS_MAX = 20;

/** Daten fuer den Kontext-Block: Name, Textauszug, schon verknuepfte Fundstuecke.
 *  null, wenn die Stelle nicht mehr existiert oder nicht zum Buch gehoert. */
async function loadResearchContext(rc, bookId) {
  if (!rc?.kind || !rc?.id) return null;
  let name = '';
  let html = '';
  if (rc.kind === 'page') {
    const page = await contentStore.loadPage(rc.id).catch(() => null);
    if (!page || page.book_id !== bookId) return null;
    name = page.name || '';
    html = page.html || '';
  } else {
    const chapter = await contentStore.loadChapter(rc.id).catch(() => null);
    if (!chapter || chapter.book_id !== bookId) return null;
    name = chapter.name || '';
    const metas = (await contentStore.listPages(bookId).catch(() => []))
      .filter(p => p.chapter_id === rc.id)
      .slice(0, CONTEXT_CHAPTER_PAGES);
    const pages = await contentStore.loadPagesBatch(metas, null, { onError: () => null }).catch(() => []);
    html = pages.filter(Boolean).map(p => p.html || '').join('\n');
  }
  const text = htmlToTextForPrompt(html).trim();
  const excerpt = text.length > CONTEXT_EXCERPT_MAX ? text.slice(0, CONTEXT_EXCERPT_MAX) + ' …' : text;
  const ids = itemIdsAtPlace(bookId, rc.kind === 'page' ? { pageId: rc.id } : { chapterId: rc.id });
  const items = ids.length
    ? db.prepare(`SELECT id, kind, title, status FROM research_items
                   WHERE id IN (${ids.map(() => '?').join(',')}) AND archived = 0
                   ORDER BY updated_at DESC LIMIT ${CONTEXT_ITEMS_MAX}`).all(...ids)
    : [];
  return { kind: rc.kind, name, excerpt, items };
}

module.exports = {
  toolsForRound, validateAnswerSources, sessionProposalMemory, proposalsOnlyFallback,
  researchMessageContext, readMessageContext, loadResearchContext,
};
