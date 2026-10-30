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
//     um ihre Nachbarn erweitert, auf den LIVE-Seitentext abgebildet und pro Seite
//     zu einem Auszug gebündelt; seit dem Indexlauf geänderte Seiten per Keyword).
//   preContextPassages     — kleiner Erst-Kontext (wenige Treffer, harter
//     Zeichendeckel; Abschnitts-Treffer ebenfalls auf den LIVE-Text abgebildet):
//     agentischer Buch-, Plot- und Ideen-Chat, klassischer Plot-/Ideen-Chat und
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
const { resolveEntityTitle, semanticIndexStatus, relevanceFields } = require('../chat-tools/shared');
const { i18nError, htmlToText } = require('../shared');
const { FALLBACK_PLACEHOLDER } = require('../agentic-chat/history');
const { bestLivePassage } = require('../../../lib/live-passage');

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
 * Frage; Antworten ohne Inhalt (i18n-Marker bzw. deren Platzhalter) zählen nicht —
 * dann trägt die letzte echte Antwort davor.
 */
// Antwort ohne Inhalt: roher i18n-Marker (Verlauf des Seiten-Chats) oder der
// Platzhalter, durch den buildAgenticHistory die Marker ersetzt (agentische Chats).
function _isContentlessAnswer(content) {
  const c = content.trimStart();
  return c.startsWith('__i18n:') || c.startsWith(FALLBACK_PLACEHOLDER);
}

function retrievalQuery(message, history) {
  const prev = Array.isArray(history) ? [...history].reverse() : [];
  const lastUser = prev.find(m => m.role === 'user' && typeof m.content === 'string');
  const lastAsst = prev.find(m => m.role === 'assistant' && typeof m.content === 'string' && !_isContentlessAnswer(m.content));
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
 * Seite, Reihenfolge = Relevanz des besten Treffers der Seite).
 *
 * Live-Text statt Index-Text: der Index ist ein Ableitungs-Index und kann hinter
 * dem Seitenstand zurückliegen. Jede Passage wird darum über bestLivePassage auf
 * den AKTUELLEN Seitentext abgebildet (geladen werden nur die Trefferseiten); ist
 * die Stelle umgeschrieben oder gelöscht, fällt die Passage weg statt veralteten
 * Text als Buchaussage zu zeigen. Seiten, die seit dem letzten vollständigen
 * Indexlauf neu oder bearbeitet sind (semanticIndexStatus.changedPageIds), stehen
 * im Index gar nicht oder in alter Fassung — sie kommen über `scoreText` (das
 * Keyword-Scoring des Aufrufers) dazu, damit frischer Text nicht unsichtbar ist.
 * Höchstens FRESH_BUDGET_SHARE des Budgets geht an diese Seiten.
 *
 * Optionen: signal, userEmail (User-Scope der Pipeline), scoreText(query, text)
 * → Zahl (ohne: keine Frisch-Seiten).
 * Rückgabe:
 *   { status: 'ok', selectedPages, usedChars, totalPages, freshPages }
 *   { status: 'no_index' } — kein oder unvollständiger Index (Lauf fehlt/brach ab):
 *     Treffer wären nur ein Teil des Buchs, der Aufrufer nimmt Keyword-Scoring.
 *   { status: 'no_hits' }  — Index vollständig, aber nichts Passendes.
 * Wirft nur bei Abort/Backend-Fehler.
 */
async function selectPassagesSemantic(bookId, query, budgetChars, signal, { userEmail = null, scoreText = null } = {}) {
  let pages;
  try { pages = await contentStore.listPages(bookId); }
  catch (e) {
    if (e?.status) throw i18nError('job.error.contentStorePageList', { status: e.status });
    throw e;
  }
  const index = await semanticIndexStatus(bookId, pages);
  if (!index.ready) return { status: 'no_index' };
  const metaById = new Map(pages.map(p => [p.id, p]));

  const topK = parseInt(appSettings.get('jobs.book_chat.rag_top_k'), 10) || 40;
  const hits = (await semanticRetrieval.semanticQuery(bookId, query, {
    kinds: ['page'], topK, signal, user: userEmail,
    perEntity: semanticRetrieval.PASSAGES_PER_ENTITY, minChunkGap: RAG_MIN_CHUNK_GAP,
  })).filter(h => h.kind === 'page' && metaById.has(h.entity_id)); // gelöschte Seiten: Chunk noch im Index

  // Live-Text: Trefferseiten + seit dem Indexlauf geänderte Seiten, eine Ladung.
  const fresh = scoreText ? index.changedPageIds.filter(id => metaById.has(id)) : [];
  const liveIds = [...new Set([...hits.map(h => h.entity_id), ...fresh])];
  const liveText = await _loadLiveTexts(liveIds, signal);

  // Frisch-Seiten nach Keyword-Relevanz; ohne Treffer im Text bleiben sie draussen.
  const freshScored = fresh
    .map(id => ({ id, text: liveText.get(id) || '', score: 0 }))
    .map(f => ({ ...f, score: f.text ? scoreText(query, f.text) : 0 }))
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score);
  const semBudget = freshScored.length ? Math.floor(budgetChars * (1 - FRESH_BUDGET_SHARE)) : budgetChars;

  const byPage = new Map(); // page_id → [{ ix, text }] in Relevanz-Reihenfolge der ersten Passage
  let usedChars = 0;
  for (const item of _expand(hits)) {
    if (usedChars >= semBudget) break;
    const live = liveText.get(item.hit.entity_id);
    if (!live) continue; // Seite nicht ladbar / leer
    const parts = byPage.get(item.hit.entity_id);
    const sep = parts ? PASSAGE_SEPARATOR.length : 0;
    const remaining = semBudget - usedChars - sep;
    const text = _livePassage(live, item, remaining);
    if (!text || text.length < MIN_PASSAGE_CHARS) continue;
    if (parts && parts.some(p => p.text === text)) continue; // zwei Chunks → dieselbe Live-Stelle
    const ix = Number.isInteger(item.hit.chunk_ix) ? item.hit.chunk_ix : 0;
    if (parts) parts.push({ ix, text });
    else byPage.set(item.hit.entity_id, [{ ix, text }]);
    usedChars += text.length + sep;
  }

  let freshPages = 0;
  for (const f of freshScored) {
    if (usedChars >= budgetChars) break;
    if (byPage.has(f.id)) continue; // schon über einen (live abgebildeten) Treffer drin
    const text = f.text.slice(0, budgetChars - usedChars);
    if (text.length < MIN_PASSAGE_CHARS) continue;
    byPage.set(f.id, [{ ix: 0, text }]);
    usedChars += text.length;
    freshPages++;
  }

  if (!byPage.size) return { status: 'no_hits' };
  const selectedPages = [];
  for (const [pageId, parts] of byPage) {
    const meta = metaById.get(pageId);
    const text = parts.sort((a, b) => a.ix - b.ix).map(p => p.text).join(PASSAGE_SEPARATOR);
    selectedPages.push({ name: meta.name, id: meta.id, slug: meta.slug, book_slug: meta.book_slug, text });
  }
  return { status: 'ok', selectedPages, usedChars, totalPages: pages.length, freshPages };
}

// Aktueller Klartext der Seiten `ids` in einer Ladung (Map page_id → Text). Nicht
// ladbare Seiten fehlen in der Map — ihr Treffer fällt beim Aufrufer weg.
async function _loadLiveTexts(ids, signal) {
  const liveText = new Map();
  if (!ids.length) return liveText;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const loaded = await contentStore.loadPagesBatch(ids.map(id => ({ id })), null, { onError: () => null });
  for (const pd of loaded) liveText.set(pd.id, htmlToText(pd.html || '').trim());
  return liveText;
}

// Anteil des RAG-Budgets, den seit dem Indexlauf geänderte Seiten höchstens belegen.
const FRESH_BUDGET_SHARE = 0.25;

// Passage im Live-Text: erst die Nachbarschaft, sonst der Treffer-Chunk allein als
// Wegweiser; beide auf das Rest-Budget gedeckelt. null = Stelle gibt es nicht mehr.
function _livePassage(live, { wide, core }, remaining) {
  if (remaining < MIN_PASSAGE_CHARS) return null;
  for (const probe of wide.length <= remaining ? [wide, core] : [core]) {
    if (!probe) continue;
    const found = bestLivePassage(live, probe, { maxChars: Math.min(remaining, Math.max(probe.length, MIN_PASSAGE_CHARS)) });
    if (found) return found.text.slice(0, remaining);
  }
  return null;
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
 * Rückgabe: { hits:[{ kind, entity_id, title, chapter_path?, rank, similarity?, text }],
 * chars, indexIncomplete, stalePages, staleDropped? } — `hits` kann leer sein;
 * `staleDropped` zählt Abschnitts-Treffer, deren Stelle im Live-Text fehlt; `indexIncomplete` sagt,
 * ob der Index nur einen Teil des Buchs abdeckt (Lauf fehlt/brach ab oder `stalePages`
 * Abschnitte seit dem Lauf neu/geändert). null = abgeschaltet (top_k/chars 0).
 * `rank`/`similarity` (roher Cosinus) sind stabil; der stufenabhängige Pipeline-`score`
 * geht nicht ans Modell.
 */
async function preContextPassages(bookId, query, {
  signal, userEmail = null, topK = null, chars = null, excludePageIds = null,
} = {}) {
  const k = topK != null ? topK : parseInt(appSettings.get('jobs.book_chat.pre_rag_top_k'), 10);
  const budget = chars != null ? chars : parseInt(appSettings.get('jobs.book_chat.pre_rag_chars'), 10);
  if (!(k > 0) || !(budget > 0)) return null;
  const exclude = new Set(excludePageIds || []);

  // Index-Stand mitgeben: ein unvollständiger/veralteter Index liefert nur einen Teil
  // des Buchs — der Prompt sagt das dem Modell, damit «kein Treffer» nicht als «steht
  // nicht im Buch» gelesen wird.
  const index = await semanticIndexStatus(bookId);
  const status = { indexIncomplete: index.incomplete, stalePages: index.changedPageIds.length };

  // Ausgeschlossene Seiten belegen sonst Plätze im topK — darum um ihre Zahl grösser
  // ziehen. User-Scope greift in der Pipeline VOR dem topK-Schnitt.
  const raw = await semanticRetrieval.semanticQuery(bookId, query, {
    kinds: PRE_CONTEXT_KINDS, topK: k + exclude.size, signal, user: userEmail,
  });
  const kept = [];
  for (const h of raw) {
    if (kept.length >= k) break;
    if (h.kind === 'page' && exclude.has(h.entity_id)) continue;
    const title = resolveEntityTitle(h.kind, h.entity_id, { userEmail });
    if (title == null) continue; // Entität gelöscht / fremder User, Chunk noch im Index
    kept.push({ ...h, title, rank: kept.length + 1 });
  }
  if (!kept.length) return { hits: [], chars: 0, ...status };

  // Abschnitts-Treffer: Kapitelpfad mitgeben, damit der Ausschnitt im Buch verortbar ist.
  const pathById = new Map();
  if (kept.some(h => h.kind === 'page')) {
    for (const n of await contentStore.bookOutline(bookId)) {
      if (n.type === 'page' && n.path.length) pathById.set(n.id, contentStore.formatChapterPath(n.path));
    }
  }

  // Abschnitts-Treffer zeigen den LIVE-Text (wie selectPassagesSemantic): der
  // Index-Chunk kann hinter dem Seitenstand liegen und darf nicht als Buchtext
  // erscheinen. Findet sich die Stelle nicht mehr, fällt die Passage weg.
  // Szenen/Figuren/Orte/Fakten sind Analyse-Daten, kein Buchtext — sie bleiben.
  const liveText = await _loadLiveTexts([...new Set(kept.filter(h => h.kind === 'page').map(h => h.entity_id))], signal);

  const hits = [];
  let used = 0;
  let stale = 0;
  for (const item of _expand(kept)) {
    if (used >= budget) break;
    const h = item.hit;
    let text;
    if (h.kind === 'page') {
      const live = liveText.get(h.entity_id);
      text = live ? _livePassage(live, item, budget - used) : null;
      if (!text) { stale++; continue; }
    } else {
      text = _fit(item, budget - used);
    }
    if (text.length < MIN_PASSAGE_CHARS) continue;
    hits.push({
      kind: h.kind,
      entity_id: h.entity_id,
      title: h.title,
      ...(h.kind === 'page' && pathById.has(h.entity_id) ? { chapter_path: pathById.get(h.entity_id) } : {}),
      ...relevanceFields(h, h.rank),
      text,
    });
    used += text.length;
  }
  return { hits, chars: used, ...status, ...(stale ? { staleDropped: stale } : {}) };
}

/**
 * Erst-Kontext der agentischen Chats (Buch-, Plot- und Ideen-Chat), non-fatal: ohne
 * Embedding-Endpunkt oder ohne Suchtext null — der Agent arbeitet dann rein über
 * seine Werkzeuge. Bei Backend-Fehler `{ hits: [], chars: 0, error: true }`, damit
 * der Prompt «Suche ausgefallen» von «nichts gefunden» unterscheidet. Nur ein Abbruch
 * wird weitergeworfen.
 */
async function agentPreContext(bookId, query, { signal, logger, userEmail = null } = {}) {
  if (!embed.isEnabled() || !query) return null;
  try {
    const pre = await preContextPassages(bookId, query, { signal, userEmail });
    if (pre) {
      logger?.info?.(`Erst-Kontext: ${pre.hits.length} Passagen, ${pre.chars} Zeichen`
        + `${pre.indexIncomplete ? `, Index unvollständig (${pre.stalePages} Abschnitte seit Lauf geändert)` : ''}`
        + `${pre.staleDropped ? `, ${pre.staleDropped} veraltete Index-Stellen verworfen` : ''}.`);
    }
    return pre;
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    logger?.warn?.(`Erst-Kontext-Retrieval fehlgeschlagen (${e.message}) – Agent arbeitet nur über Werkzeuge.`);
    return { hits: [], chars: 0, error: true };
  }
}

/** Status-Teil eines Erst-Kontexts für die Prompt-Bausteine (buildBookChatPreContext,
 *  Plot-/Ideen-Chat `passageStatus`): disabled / error / indexIncomplete + stalePages. */
function preContextStatus(pre, { enabled = embed.isEnabled() } = {}) {
  if (!enabled) return { disabled: true };
  if (!pre) return {};
  return {
    ...(pre.error ? { error: true } : {}),
    ...(pre.indexIncomplete ? { indexIncomplete: true, stalePages: pre.stalePages || 0 } : {}),
  };
}

module.exports = {
  selectPassagesSemantic, preContextPassages, agentPreContext, preContextStatus, retrievalQuery, PRE_CONTEXT_KINDS,
};
