'use strict';
// Reine Hilfen des Recherche-Chats (routes/jobs/research-chat.js), ausgelagert
// damit sie ohne Loop/KI unit-testbar sind:
//   toolsForRound          — Werkzeugliste unter dem Web-Such-Gesamtdeckel
//   validateAnswerSources  — `final_answer.quellen` gegen die Web-Treffer des Jobs
//   sessionProposalMemory  — frühere Vorschläge der Session (für den System-Prompt)
//   proposalsOnlyFallback  — Antworttext, wenn nur Vorschläge, aber kein Text kamen
//   markProposalUrls       — Vorschlags-URLs gegen das in diesem Lauf Abgerufene markieren
//   researchIdeeProposals  — `final_answer.ideen` an den Schreibkontext der Frage hängen

const { normalizeUrl } = require('../../lib/url-normalize');
const { cleanStr, TITLE_MAX } = require('../../lib/research-validate');
const { resolvePageBookId, resolveChapterBookId } = require('../../lib/content-ownership');
const contentStore = require('../../lib/content-store');
const { itemIdsAtPlace } = require('../../db/research-items');
const {
  sessionProposalContextInfos, messageContextInfo, activeResearchItemsByIds,
  sessionAnswerSourceInfos, existingResearchItemIds,
} = require('../../db/research-jobs');
const { syncUrlIndex } = require('./research-url-index');
const { htmlToTextForPrompt, bookTextOpts } = require('./shared');
const { normalizeChatIdeeProposals } = require('../../lib/chat-idee-proposals');
const { CHANGE_TYPES } = require('../../db/research-changes');

/**
 * Werkzeugliste unter dem Web-Such-Gesamtdeckel: `max_uses` des serverseitigen
 * `web_search` höchstens der Rest des Deckels, bei aufgebrauchtem Deckel fällt das
 * Werkzeug weg. Der Recherche-Chat ruft das einmal beim Start — die Liste bleibt
 * danach für alle Recherche-Runden gleich, weil Werkzeuge vorn im Prompt-Cache
 * stehen und Thinking-Blöcke an den unveränderten Gesprächsanfang gebunden sind.
 * Einzige Ausnahme ist der Synthese-Call: der Loop lässt dort die serverseitigen
 * Werkzeuge (web_search) weg und nimmt den einen Cache-Fehlschlag in Kauf; die
 * eigenen Werkzeuge bleiben. Den Deckel über die Runden hält der Loop-Hook
 * `stopBeforeRound`: ist er erreicht, folgt diese Synthese. Innerhalb einer
 * Runde begrenzt nur `max_uses` (höchstens der Rest beim Start) — mehrere Suchen
 * einer Runde können den Gesamtdeckel darum knapp überschreiten.
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
function sessionProposalMemory(sessionId, limit = 30, bookId = null) {
  const out = [];
  for (const raw of sessionProposalContextInfos(sessionId)) {
    let ci;
    try { ci = JSON.parse(raw); } catch { continue; }
    for (const p of Array.isArray(ci?.proposals) ? ci.proposals : []) {
      if (p?.type === 'idee_create') {
        const content = String(p.fields?.content || '').replace(/\s+/g, ' ').trim();
        if (!content) continue;
        out.push({
          title: content.slice(0, 120),
          kind: 'idee',
          idee_state: p.applied_at ? 'applied' : (p.status === 'discarded' ? 'discarded' : 'open'),
        });
        continue;
      }
      if (CHANGE_TYPES.has(p?.type)) {
        out.push({
          kind: 'change',
          item_id: p.item_id,
          title: String(p.labels?.item || '').slice(0, 120),
          what: changeSummary(p),
          change_state: p.applied_at ? 'applied' : (p.status === 'discarded' ? 'discarded' : 'open'),
        });
        continue;
      }
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
  const list = out.slice(-limit);
  // Gespeichert und inzwischen gelöscht: das Gedächtnis darf den Eintrag nicht mehr
  // als «im Archiv als id=X» nennen — read_research_item fände ihn nicht.
  if (bookId) {
    const ids = [...new Set(list.flatMap(e => [e.saved_item_id, e.exists_item_id]).filter(Boolean))];
    const alive = existingResearchItemIds(ids, bookId);
    for (const e of list) {
      if (e.saved_item_id && !alive.has(e.saved_item_id)) e.saved_item_id = null;
      if (e.exists_item_id && !alive.has(e.exists_item_id)) e.exists_item_id = null;
    }
  }
  return list;
}

/**
 * Geprüfte Quellen der jüngsten Antworten dieser Session (context_info.answer_sources),
 * dedupliziert, neueste zuerst. Ihre Herkunft ist dieselbe wie die eines Treffers
 * dieses Laufs (damals gesucht bzw. gelesen und gegen die Treffer geprüft) — eine
 * Folgefrage («lies die zweite Quelle genauer») darf sie lesen und belegen.
 */
function sessionPriorSources(sessionId, { answers = 5, max = 40 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of sessionAnswerSourceInfos(sessionId, answers)) {
    let ci;
    try { ci = JSON.parse(raw); } catch { continue; }
    for (const s of Array.isArray(ci?.answer_sources) ? ci.answer_sources : []) {
      const n = normalizeUrl(s?.url);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push({ url: s.url, title: s.title || s.url });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Kurzform einer Änderung fürs Gedächtnis («Status → eingearbeitet, Text angehängt»). */
function changeSummary(p) {
  if (p.type === 'research_archive') return 'archivieren';
  if (p.type === 'research_merge') return `Eintrag id=${p.merge_item_id} hineinführen`;
  const f = p.fields || {};
  const parts = [];
  if (f.status) parts.push(`Status → ${f.status}`);
  if (f.title) parts.push('Titel neu');
  if (f.body) parts.push('Text neu');
  if (f.append) parts.push('Text angehängt');
  if (f.source) parts.push('Quelle neu');
  if (p.urls?.length) parts.push(`${p.urls.length} URL(s) dazu`);
  if (f.tags?.length) parts.push(`Tags ${f.tags.join(', ')}`);
  return parts.join(', ') || 'Änderung';
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
  try { return JSON.parse(messageContextInfo(userMsgId) || 'null')?.research_context || null; } catch { return null; }
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
    // Kapitel = Teilbaum: die ersten Abschnitte in Lesereihenfolge, auch aus
    // Unterkapiteln (ein Teil, der nur Unterkapitel trägt, hätte sonst keinen Text).
    const [outline, all] = await Promise.all([
      contentStore.bookOutline(bookId).catch(() => []),
      contentStore.listPages(bookId).catch(() => []),
    ]);
    const byId = new Map(all.map(p => [p.id, p]));
    const metas = contentStore.chapterPages(outline, rc.id)
      .map(n => byId.get(n.id)).filter(Boolean)
      .slice(0, CONTEXT_CHAPTER_PAGES);
    const pages = await contentStore.loadPagesBatch(metas, null, { onError: () => null }).catch(() => []);
    html = pages.filter(Boolean).map(p => p.html || '').join('\n');
  }
  const text = htmlToTextForPrompt(html, bookTextOpts(bookId)).trim();
  const excerpt = text.length > CONTEXT_EXCERPT_MAX ? text.slice(0, CONTEXT_EXCERPT_MAX) + ' …' : text;
  const ids = itemIdsAtPlace(bookId, rc.kind === 'page' ? { pageId: rc.id } : { chapterId: rc.id });
  const items = activeResearchItemsByIds(ids, CONTEXT_ITEMS_MAX);
  return { kind: rc.kind, name, excerpt, items };
}

/**
 * Ideen-Vorschläge aus `final_answer.ideen`. Der Recherche-Chat liest das
 * Manuskript nicht und kennt keine Abschnitts-IDs — Anker ist allein der
 * Schreibkontext der Frage (Kontext-Chip): beim Abschnitt dieser selbst bzw. mit
 * `ort: 'kapitel'` dessen Kapitel, beim Kapitel das Kapitel. Vom Modell genannte
 * IDs fallen weg (geraten). Ohne Schreibkontext keine Ideen. Format und Prüfung
 * wie in Abschnitts- und Buch-Chat (lib/chat-idee-proposals.js).
 *
 * @param {unknown} raw  final_answer.ideen
 * @param {{kind:'page'|'chapter', id:number}|null} rc  Schreibkontext (readMessageContext)
 * @param {number} bookId
 */
function researchIdeeProposals(raw, rc, bookId) {
  if (!Array.isArray(raw) || !rc?.id || (rc.kind !== 'page' && rc.kind !== 'chapter')) return [];
  const items = raw.map(i => {
    if (!i || typeof i !== 'object') return null;
    const base = { inhalt: i.inhalt, begruendung: i.begruendung };
    return rc.kind === 'chapter'
      ? { ...base, chapter_id: rc.id }
      : { ...base, ort: i.ort === 'kapitel' ? 'kapitel' : 'abschnitt' };
  });
  return normalizeChatIdeeProposals(items, { bookId, defaultPageId: rc.kind === 'page' ? rc.id : null });
}

/**
 * Jede Vorschlags-URL bekommt `verified: true|false` — ob sie in DIESEM Lauf
 * tatsächlich abgerufen bzw. geliefert wurde: Web-Treffer (Server-Tool wie
 * SearXNG), gelesene Seiten samt Redirect-Ziel, Literatur-Treffer, Links aus der
 * User-Nachricht, URLs der Archiv-Einträge des Buchs. Vergleich normalisiert
 * (lib/url-normalize). Eine unbelegte URL bleibt stehen (der User entscheidet),
 * das Frontend markiert sie und lässt sie bei «Alle speichern» aus.
 * Derselbe URL-Index wie die Herkunftsprüfung von read_web_page
 * (./research-url-index.js). Mutiert und liefert `proposals`.
 *
 * @param {Array} proposals  ctx.proposals ({ urls: [{url,label}] })
 * @param {object} seen      { ctx, webResults } im Job (Index des Laufs), sonst
 *                           { webResults, pages, literatureHits, userMessageUrls, bookId }
 */
function markProposalUrls(proposals, { ctx = null, webResults = [], pages = [], literatureHits = [], userMessageUrls = [], bookId = null } = {}) {
  if (!Array.isArray(proposals) || !proposals.some(p => p?.urls?.length)) return proposals || [];
  const known = syncUrlIndex(ctx || { web: { pages }, literatureHits, userMessageUrls, bookId }, { webResults });
  for (const p of proposals) {
    if (!Array.isArray(p?.urls)) continue;
    p.urls = p.urls.map(u => ({ ...u, verified: known.has(normalizeUrl(u.url)) }));
  }
  return proposals;
}

module.exports = {
  markProposalUrls, researchIdeeProposals,
  toolsForRound, validateAnswerSources, sessionProposalMemory, sessionPriorSources, proposalsOnlyFallback,
  researchMessageContext, readMessageContext, loadResearchContext,
};
