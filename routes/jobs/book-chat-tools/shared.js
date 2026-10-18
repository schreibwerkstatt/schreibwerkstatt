'use strict';
// Geteilte Helfer für Buch-Chat-Tools. Bündelt Token-Budget-Klemmgrenzen,
// das _truncateResult-Pattern und die _findFigure-Lookup-Heuristik.

const { INPUT_BUDGET_CHARS } = require('../../../lib/ai');
const { pageTitle } = require('../../../db/content-names');
const { truncateToolResult } = require('./truncate');
const {
  getFigureByFigId, findFigureByName, getSceneTitle, getFigureName,
  getSceneTitleForUser, getFigureNameForUser,
} = require('../../../db/book-chat/figures');
const { getLocationName } = require('../../../db/locations-read');
const { getWorldFactTitle } = require('../../../db/world-facts');
const { itemTitle: getResearchItemTitle } = require('../../../db/research-items');
const contentStore = require('../../../lib/content-store');
const semanticRetrieval = require('../../../lib/semantic-retrieval');

// Obergrenzen schützen das Token-Budget gegen ausufernde Tool-Calls. Skaliert mit
// MODEL_CONTEXT, damit User mit grösserem Kontextfenster reichere Tool-Antworten
// bekommen (mehr Seiten, längere Snippets). Der Loop (agentic-chat.js) schneidet
// zusätzlich hart auf `toolResultCap` (book-chat.js#_toolResultCapChars), bevor die
// Antwort an das Modell geht — executeTool kürzt darum vorher strukturiert auf
// denselben Deckel (resultCapFor).
// Divisor 36 ≈ BOOK_CHAT_MAX_TOOL_ITER (6) × typische Tool-Calls/Iter (3) × Sicherheit (2).
const MAX_RESULT_CHARS       = Math.max(4000, Math.floor(INPUT_BUDGET_CHARS / 36));
const MAX_CHARS_PER_PAGE     = MAX_RESULT_CHARS;
const DEFAULT_CHARS_PER_PAGE = Math.max(2000, Math.floor(MAX_CHARS_PER_PAGE * 0.4));
// Listen-Limits bleiben fix (UI-Ergonomie, nicht Kontextfenster-Schutz):
const MAX_SEARCH_RESULTS     = 30;
const MAX_PAGES_PER_FETCH    = 20;
const SEARCH_SNIPPET_CONTEXT = 120; // Zeichen vor + nach dem Treffer

/** Kürzt ein Tool-Result-Objekt strukturerhaltend (truncate.js), damit es nicht das
 *  Token-Budget sprengt. `maxChars` default MAX_RESULT_CHARS; executeTool reicht
 *  zusätzlich den Loop-Deckel aus ctx.resultCapChars durch, damit der harte
 *  String-Schnitt im Loop (agentic-chat.js) praktisch nie greift. */
function _truncateResult(obj, maxChars = MAX_RESULT_CHARS) {
  return truncateToolResult(obj, maxChars);
}

/** Effektiver Ergebnis-Deckel eines Tool-Calls: kleinerer Wert aus dem globalen
 *  MAX_RESULT_CHARS und dem Loop-Deckel des laufenden Jobs (ctx.resultCapChars). */
function resultCapFor(ctx) {
  const loopCap = Number(ctx?.resultCapChars) || 0;
  return loopCap > 0 ? Math.min(MAX_RESULT_CHARS, loopCap) : MAX_RESULT_CHARS;
}

/**
 * Titel einer semantisch getroffenen Entität (page/scene/figure/location/fact/
 * research). Geteilt von `search_similar` (tools-similar.js) und den Erst-Kontext-/
 * RAG-Blöcken der Chats (routes/jobs/chat/book-chat-retrieval.js) — alle lösen
 * dieselben Kinds des Embedding-Index auf. Rückgabe null = Entität gelöscht (Chunk
 * noch im Index) oder unbekanntes Kind.
 *
 * `opts.userEmail` (gesetzt = User-Scope): Szenen, Figuren, Orte und Welt-Fakten sind
 * Analyse-Daten pro User, der Embedding-Index hängt aber nur am Buch. Mit userEmail
 * fallen die eines anderen Users im selben Buch weg (null wie gelöscht) — sonst sähe
 * ein Mitautor über search_similar/Erst-Kontext die Analyse-Texte des anderen.
 * Recherche-Einträge sind buchweit geteilt und darum nie user-gefiltert.
 */
function resolveEntityTitle(kind, entityId, opts = {}) {
  const scoped = Object.prototype.hasOwnProperty.call(opts, 'userEmail');
  const user = opts.userEmail ?? null;
  if (kind === 'page')   return pageTitle(entityId)?.title ?? null;
  if (kind === 'scene')  return (scoped ? getSceneTitleForUser(entityId, user) : getSceneTitle(entityId)) ?? null;
  if (kind === 'figure') return (scoped ? getFigureNameForUser(entityId, user) : getFigureName(entityId)) ?? null;
  const scope = scoped ? { userEmail: user } : {};
  if (kind === 'location') return getLocationName(entityId, scope) ?? null;
  if (kind === 'fact')     return getWorldFactTitle(entityId, scope) ?? null;
  if (kind === 'research') return getResearchItemTitle(entityId) ?? null;
  return null;
}

/**
 * Stand des Embedding-Index eines Buchs, so wie ihn ein Chat-Modell kennen muss,
 * bevor es «keine Treffer» als «steht nicht im Buch» liest. Geteilt von
 * `search_similar` (tools-similar.js) und den Erst-Kontext-/RAG-Blöcken der Chats
 * (routes/jobs/chat/book-chat-retrieval.js).
 *
 * `ready` = vollständiger Indexlauf unter dem aktiven Modell
 * (semanticRetrieval.indexState). `changedPageIds` = Abschnitte, deren `updated_at`
 * nach dem Start des letzten vollständigen Laufs liegt (neu oder bearbeitet — ihr
 * Text fehlt im Index oder liegt dort in einer älteren Fassung). `incomplete` =
 * eines von beiden. `pages` (optional): schon geladene listPages-Zeilen, spart den
 * zweiten Zugriff.
 * @returns {Promise<{ ready: boolean, lastIndexedAt: string|null, changedPageIds: number[], incomplete: boolean }>}
 */
async function semanticIndexStatus(bookId, pages = null) {
  const st = semanticRetrieval.indexState(bookId) || {};
  const ready = !!st.ready;
  const lastIndexedAt = st.lastIndexedAt || null;
  let changedPageIds = [];
  const since = ready && lastIndexedAt ? Date.parse(lastIndexedAt) : NaN;
  if (Number.isFinite(since)) {
    const rows = pages || await contentStore.listPages(bookId);
    changedPageIds = rows
      .filter(p => { const t = Date.parse(p.updated_at || ''); return Number.isFinite(t) && t > since; })
      .map(p => p.id);
  }
  return { ready, lastIndexedAt, changedPageIds, incomplete: !ready || changedPageIds.length > 0 };
}

/** Hinweisfeld für Werkzeug-Ergebnisse über den Bedeutungs-Index (search_similar):
 *  bei unvollständigem Index `{ index_incomplete: true, index_hint }`, sonst {}. */
function indexIncompleteFields(status) {
  if (!status?.incomplete) return {};
  const hint = status.ready
    ? `${status.changedPageIds.length} Abschnitt(e) sind seit dem letzten Indexlauf neu oder geändert und fehlen hier ganz oder in neuer Fassung.`
    : 'Der Bedeutungs-Index dieses Buchs ist unvollständig (Indexlauf fehlt oder brach ab).';
  return {
    index_incomplete: true,
    index_hint: `${hint} Fehlende Treffer heissen NICHT, dass etwas nicht im Buch steht — prüfe mit search_passages (Wortlaut) oder get_chapter_text.`,
  };
}

// Stabile Relevanzangabe eines semanticQuery-Treffers: `rank` (1 = bester) und
// `similarity` = roher Cosinus (semScore), gerundet; fehlt er (reiner
// Wortlaut-Treffer), nur der Rang. Geteilt von search_similar
// und dem Erst-Kontext (routes/jobs/chat/book-chat-retrieval.js).
function relevanceFields(h, rank) {
  return {
    rank,
    ...(Number.isFinite(h.semScore) ? { similarity: Math.round(h.semScore * 100) / 100 } : {}),
  };
}

/** Lookup einer Figur per fig_id (exakt) oder figur_name (LIKE + Exact-Match-Bonus). */
function _findFigure(input, ctx) {
  const userEmail = ctx.userEmail || null;
  let row = null;
  if (input.figur_id) {
    row = getFigureByFigId(ctx.bookId, input.figur_id, userEmail);
  }
  if (!row && input.figur_name) {
    row = findFigureByName(ctx.bookId, userEmail, input.figur_name);
  }
  return row;
}

/** Abschnitts-Zeilen (`page_id`) in Lesereihenfolge der Gliederung sortieren
 *  (contentStore.bookOutline, SSoT order_json). SQL-Sortierung nach
 *  chapters/pages.position reicht dafür nicht: pages.position zählt pro Bucket, und
 *  Abschnitte ohne Kapitel (position NULL) landeten vorn statt an ihrer Stelle. */
async function sortByReadingOrder(bookId, rows) {
  const outline = await contentStore.bookOutline(bookId);
  const ord = new Map();
  for (const n of outline) if (n.type === 'page') ord.set(n.id, ord.size);
  return rows.slice().sort((a, b) => (ord.get(a.page_id) ?? Infinity) - (ord.get(b.page_id) ?? Infinity));
}

module.exports = {
  MAX_RESULT_CHARS,
  MAX_CHARS_PER_PAGE,
  DEFAULT_CHARS_PER_PAGE,
  MAX_SEARCH_RESULTS,
  MAX_PAGES_PER_FETCH,
  SEARCH_SNIPPET_CONTEXT,
  _truncateResult,
  resultCapFor,
  _findFigure,
  resolveEntityTitle,
  sortByReadingOrder,
  semanticIndexStatus,
  indexIncompleteFields,
  relevanceFields,
};
