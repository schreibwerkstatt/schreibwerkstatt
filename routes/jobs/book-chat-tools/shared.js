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
};
