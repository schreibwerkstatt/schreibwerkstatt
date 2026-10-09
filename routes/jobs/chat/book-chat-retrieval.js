'use strict';
// Semantisches Retrieval der Chats. Alle Pfade gehen über dieselbe geteilte
// Pipeline lib/semantic-retrieval.js#semanticQuery (Cosinus + Hybrid-RRF +
// optional Rerank) — exakt die, die auch das agentische Tool `search_similar` und
// die Such-Karte benutzen — und erweitern jeden Treffer per `withNeighbors` um die
// Nachbar-Chunks derselben Entität (ein Chunk allein schneidet die Antwort oft mitten
// im Gedanken ab). Sie unterscheiden sich nur darin, WAS sie damit füllen:
//
//   selectPassagesSemantic — klassischer Buch-Chat: füllt das ganze Text-Budget des
//     System-Prompts (bis zu PASSAGES_PER_ENTITY getrennte Passagen pro Seite, je
//     um ihre Nachbarn erweitert, pro Seite zu einem Auszug gebündelt).
//   preContextPassages     — kleiner Erst-Kontext (wenige Treffer, harter
//     Zeichendeckel): agentischer Buch- und Plot-Chat, klassischer Plot-Chat und
//     der Buch-Block des Seiten-Chats. Macht die häufigste Frageform („wie alt war
//     X", „wann hat X …") ohne Werkzeug-Runde beantwortbar — die paar Tausend Tokens
//     hier sind billiger als eine einzige get_chapter_text-Runde.
//   retrievalQuery         — Suchtext aus Frage + letzter Runde (Folgefragen).
//
// Rein rückwärtsgewandt: findet Bestehendes, schreibt nie in den Buchtext.

const contentStore = require('../../../lib/content-store');
const appSettings = require('../../../lib/app-settings');
const embed = require('../../../lib/embed');
const semanticRetrieval = require('../../../lib/semantic-retrieval');
const { resolveEntityTitle } = require('../book-chat-tools/shared');
const { i18nError } = require('../shared');

// Index-Kinds des Erst-Kontexts. Recherche-Material bleibt draussen: es ist Fremd-
// text (Quellen, Notizen), keine Buchaussage — der Buch-Chat liest es gezielt über
// list_research_items/read_research_item.
const PRE_CONTEXT_KINDS = ['page', 'scene', 'figure', 'location', 'fact'];

// Mindestlänge eines Ausschnitts — darunter trägt er keine Aussage.
const MIN_PASSAGE_CHARS = 50;

/**
 * Suchtext für das Retrieval: aktuelle Frage plus die letzte Runde. Folgefragen
 * («und wie alt war sie da?») tragen ihr Subjekt nicht selbst — ohne die Vorfrage
 * findet die semantische Suche die falschen Stellen. Gekappt, damit der Text die
 * aktuelle Frage nicht überstimmt. `history` = [{ role, content }] ohne die aktuelle
 * Frage; i18n-Marker (Fehler-/Fallback-Antworten) zählen nicht als Antwort.
 */
function retrievalQuery(message, history) {
  const prev = Array.isArray(history) ? [...history].reverse() : [];
  const lastUser = prev.find(m => m.role === 'user' && typeof m.content === 'string');
  const lastAsst = prev.find(m => m.role === 'assistant' && typeof m.content === 'string' && !m.content.startsWith('__i18n:'));
  return [
    lastUser ? lastUser.content.slice(0, 400) : null,
    lastAsst ? lastAsst.content.slice(0, 300) : null,
    message,
  ].filter(Boolean).join('\n');
}

// Treffer um ihre Nachbar-Chunks erweitern. Zurück kommt pro Treffer der erweiterte
// Text UND der Original-Chunk: passt der erweiterte Ausschnitt nicht mehr ins Rest-
// Budget, fällt der Aufrufer auf den Treffer-Chunk selbst zurück (statt vom Anfang
// der Nachbarschaft abzuschneiden und den Treffer zu verlieren).
function _expand(hits) {
  // Eine Entität kann mit mehreren Passagen kommen — der Schlüssel trägt darum chunk_ix.
  const key = (h) => `${h.kind}:${h.entity_id}:${Number.isInteger(h.chunk_ix) ? h.chunk_ix : ''}`;
  const wide = new Map(semanticRetrieval.withNeighbors(hits, { radius: 1 }).map(w => [key(w), w.text]));
  return hits.map(h => ({ hit: h, wide: String(wide.get(key(h)) || h.text || ''), core: String(h.text || '') }));
}

// Text für das Rest-Budget: Nachbarschaft, wenn sie passt, sonst der Treffer-Chunk.
function _fit({ wide, core }, remaining) {
  if (wide.length <= remaining) return wide;
  return core.slice(0, remaining);
}

// Trenner zwischen zwei Passagen derselben Seite in einem RAG-Auszug.
const PASSAGE_SEPARATOR = '\n[…]\n';

// Abstand der Passagen einer Seite: jede wird um ±1 Nachbar-Chunk erweitert
// (_expand) — mit Abstand 3 überlappen die erweiterten Passagen nicht.
const RAG_MIN_CHUNK_GAP = 3;

/**
 * Mini-RAG des klassischen Buch-Chats: die semantisch relevantesten Passagen füllen
 * das Text-Budget — bis zu PASSAGES_PER_ENTITY getrennte Passagen pro Seite (ein
 * Roman mit einem Abschnitt pro Kapitel hätte sonst nur eine Stelle je Kapitel),
 * jede um ihre Nachbar-Chunks erweitert. Die Passagen einer Seite werden in
 * Text-Reihenfolge zu EINEM Auszug gebündelt (selectedPages bleibt eine Zeile pro
 * Seite, Reihenfolge = Relevanz des besten Treffers der Seite). Seiten-Metadaten via
 * listPages; der Text kommt aus dem Index, es werden KEINE Seiten-Volltexte geladen.
 *
 * Rückgabe:
 *   { status: 'ok', selectedPages, usedChars, totalPages }
 *   { status: 'no_index' } — kein oder unvollständiger Index (indexReady false):
 *     Treffer wären nur ein Teil des Buchs, der Aufrufer nimmt Keyword-Scoring.
 *   { status: 'no_hits' }  — Index vollständig, aber nichts Passendes.
 * Wirft nur bei Abort/Backend-Fehler.
 */
async function selectPassagesSemantic(bookId, query, budgetChars, signal) {
  if (!semanticRetrieval.indexReady(bookId)) return { status: 'no_index' };
  const topK = parseInt(appSettings.get('jobs.book_chat.rag_top_k'), 10) || 40;
  const hits = (await semanticRetrieval.semanticQuery(bookId, query, {
    kinds: ['page'], topK, signal,
    perEntity: semanticRetrieval.PASSAGES_PER_ENTITY, minChunkGap: RAG_MIN_CHUNK_GAP,
  })).filter(h => h.kind === 'page');
  if (!hits.length) return { status: 'no_hits' };

  let pages;
  try { pages = await contentStore.listPages(bookId); }
  catch (e) {
    if (e?.status) throw i18nError('job.error.contentStorePageList', { status: e.status });
    throw e;
  }
  const metaById = new Map(pages.map(p => [p.id, p]));

  const byPage = new Map(); // page_id → [{ ix, text }] in Relevanz-Reihenfolge der ersten Passage
  let usedChars = 0;
  // Gelöschte Seiten (Chunk noch im Index) fallen vor der Nachbar-Erweiterung heraus.
  for (const item of _expand(hits.filter(h => metaById.has(h.entity_id)))) {
    if (usedChars >= budgetChars) break;
    const parts = byPage.get(item.hit.entity_id);
    const sep = parts ? PASSAGE_SEPARATOR.length : 0;
    const text = _fit(item, budgetChars - usedChars - sep);
    if (text.length < MIN_PASSAGE_CHARS) continue;
    const ix = Number.isInteger(item.hit.chunk_ix) ? item.hit.chunk_ix : 0;
    if (parts) parts.push({ ix, text });
    else byPage.set(item.hit.entity_id, [{ ix, text }]);
    usedChars += text.length + sep;
  }
  if (!byPage.size) return { status: 'no_hits' };
  const selectedPages = [];
  for (const [pageId, parts] of byPage) {
    const meta = metaById.get(pageId);
    const text = parts.sort((a, b) => a.ix - b.ix).map(p => p.text).join(PASSAGE_SEPARATOR);
    selectedPages.push({ name: meta.name, id: meta.id, slug: meta.slug, book_slug: meta.book_slug, text });
  }
  return { status: 'ok', selectedPages, usedChars, totalPages: pages.length };
}

/**
 * Erst-Kontext: `topK` Treffer, um ihre Nachbar-Chunks erweitert und hart auf
 * `chars` gedeckelt — KEIN Budget-Füllen. semanticQuery liefert pro Entität nur
 * ihren besten Chunk; jede Seite/Szene/Figur/jeder Ort/Fakt erscheint darum
 * höchstens einmal, mit der Nachbarschaft dieses Chunks als Ausschnitt.
 *
 * Optionen:
 *   signal, userEmail — Szenen/Figuren/Orte/Fakten sind Analyse-Daten pro User, der
 *     Index hängt nur am Buch: Treffer aus der Analyse eines Mitautors fallen weg
 *     (resolveEntityTitle-Scope).
 *   topK, chars — Default `jobs.book_chat.pre_rag_top_k` / `…pre_rag_chars`; 0 = aus.
 *   excludePageIds — Seiten, die schon vollständig im Prompt stehen (Seiten-Chat).
 * Rückgabe: { hits:[{ kind, entity_id, title, score, text }], chars } oder null
 * (abgeschaltet / keine Treffer). Ein fehlender Index liefert schlicht keine Treffer.
 */
async function preContextPassages(bookId, query, {
  signal, userEmail = null, topK = null, chars = null, excludePageIds = null,
} = {}) {
  const k = topK != null ? topK : parseInt(appSettings.get('jobs.book_chat.pre_rag_top_k'), 10);
  const budget = chars != null ? chars : parseInt(appSettings.get('jobs.book_chat.pre_rag_chars'), 10);
  if (!(k > 0) || !(budget > 0)) return null;
  const exclude = new Set(excludePageIds || []);

  // Ausgeschlossene Seiten belegen sonst Plätze im topK — darum um ihre Zahl grösser ziehen.
  const raw = await semanticRetrieval.semanticQuery(bookId, query, {
    kinds: PRE_CONTEXT_KINDS, topK: k + exclude.size, signal,
  });
  const kept = [];
  for (const h of raw) {
    if (kept.length >= k) break;
    if (h.kind === 'page' && exclude.has(h.entity_id)) continue;
    const title = resolveEntityTitle(h.kind, h.entity_id, { userEmail });
    if (title == null) continue; // Entität gelöscht / fremder User, Chunk noch im Index
    kept.push({ ...h, title });
  }
  if (!kept.length) return null;

  const hits = [];
  let used = 0;
  for (const item of _expand(kept)) {
    if (used >= budget) break;
    const text = _fit(item, budget - used);
    if (text.length < MIN_PASSAGE_CHARS) continue;
    const h = item.hit;
    hits.push({
      kind: h.kind,
      entity_id: h.entity_id,
      title: h.title,
      score: Math.round(h.score * 1000) / 1000,
      text,
    });
    used += text.length;
  }
  if (!hits.length) return null;
  return { hits, chars: used };
}

/**
 * Erst-Kontext der agentischen Chats (Buch- und Plot-Chat), non-fatal: ohne
 * Embedding-Endpunkt oder bei Backend-Fehler null — der Agent arbeitet dann rein
 * über seine Werkzeuge. Nur ein Abbruch wird weitergeworfen.
 */
async function agentPreContext(bookId, query, { signal, logger, userEmail = null } = {}) {
  if (!embed.isEnabled() || !query) return null;
  try {
    const pre = await preContextPassages(bookId, query, { signal, userEmail });
    if (pre) logger?.info?.(`Erst-Kontext: ${pre.hits.length} Passagen, ${pre.chars} Zeichen.`);
    return pre;
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    logger?.warn?.(`Erst-Kontext-Retrieval fehlgeschlagen (${e.message}) – Agent arbeitet nur über Werkzeuge.`);
    return null;
  }
}

module.exports = { selectPassagesSemantic, preContextPassages, agentPreContext, retrievalQuery, PRE_CONTEXT_KINDS };
