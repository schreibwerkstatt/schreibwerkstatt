'use strict';
// Geteilte Helfer für Buch-Chat-Tools. Bündelt Token-Budget-Klemmgrenzen,
// das _truncateResult-Pattern und die _findFigure-Lookup-Heuristik.

const { INPUT_BUDGET_CHARS } = require('../../../lib/ai');
const { pageTitle, listChaptersForBook, listPageNamesForBook } = require('../../../db/content-names');
const { lastKomplettRun } = require('../../../db/komplett-delta');
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
function indexIncompleteFields(status, ctx) {
  if (!status?.incomplete) return {};
  const hint = status.ready
    ? `${status.changedPageIds.length} Abschnitt(e) sind seit dem letzten Indexlauf neu oder geändert und fehlen hier ganz oder in neuer Fassung.`
    : 'Der Bedeutungs-Index dieses Buchs ist unvollständig (Indexlauf fehlt oder brach ab).';
  const ways = offeredList(ctx, ['search_passages', 'get_chapter_text'], ' oder ');
  return {
    index_incomplete: true,
    index_hint: `${hint} Fehlende Treffer heissen NICHT, dass etwas nicht im Buch steht${ways ? ` — prüfe mit ${ways}` : ''}.`,
  };
}

// ── Verweise auf andere Werkzeuge in Ergebnissen ─────────────────────────────
// Ein Hinweis im Ergebnis («weiter mit X») darf nur ein Werkzeug nennen, das der
// laufende Chat anbietet — sonst ruft das Modell ein Werkzeug, das es nicht hat.
// ctx.offeredTools setzt routes/jobs/chat-tools/select.js für jeden Lauf; ohne
// (direkter Aufruf aus Tests) gilt alles als angeboten. Regel: ./CLAUDE.md.

/** Wird `name` im laufenden Chat angeboten? */
function offered(ctx, name) {
  const set = ctx?.offeredTools;
  return !(set instanceof Set) || set.has(name);
}

/** `text` (der `name` nennt), wenn `name` angeboten wird — sonst ''. */
function toolHint(ctx, name, text) {
  return offered(ctx, name) ? text : '';
}

/** Die angebotenen Namen aus `names`, mit `sep` verbunden ('' wenn keiner). */
function offeredList(ctx, names, sep = ', ') {
  return names.filter(n => offered(ctx, n)).join(sep);
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

// ── Parameter und Felder ─────────────────────────────────────────────────────
// Das Werkzeug-Schema wird nur auf gültiges JSON geprüft — ein `limit: "viele"`
// oder `-3` kommt am Handler an. Ein `Math.max(1, x || def)` daraus wird NaN, und
// ein NaN-Deckel greift nie (`n >= NaN` ist immer false).

/** Ganzzahl-Parameter: `v`, wenn ganzzahlig (auch als Ziffern-String), sonst `def`;
 *  danach in [min, max] geklemmt. */
function clampInt(v, def, min, max = Infinity) {
  const n = typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? Number(v) : v;
  const x = Number.isInteger(n) ? n : def;
  return Math.min(max, Math.max(min, x));
}

/** Text auf `max` Zeichen, mit «…» am Schnitt; null/undefined → ''. Schneidet nie
 *  ein Surrogatpaar entzwei (halbes Emoji → ungültiges JSON beim Provider). */
function clip(text, max) {
  const s = text == null ? '' : String(text);
  if (s.length <= max) return s;
  let end = Math.max(0, max - 1);
  const c = s.charCodeAt(end - 1);
  if (c >= 0xD800 && c <= 0xDBFF) end--;
  return s.slice(0, end) + '…';
}

/** Zeilen nach `keyFn(row)` in eine Map key → Array gruppieren, Reihenfolge der
 *  Eingabe bleibt je Gruppe erhalten. `valFn` (optional) formt den Eintrag. */
function groupBy(rows, keyFn, valFn = (r) => r) {
  const out = new Map();
  for (const r of rows || []) {
    const k = keyFn(r);
    let list = out.get(k);
    if (!list) { list = []; out.set(k, list); }
    list.push(valFn(r));
  }
  return out;
}

// ── Filterwerte ──────────────────────────────────────────────────────────────
// Filter auf ein festes Vokabular (typ, schwere, status, kind) kommen als Text vom
// Modell. Zwei stille Fehlformen gibt es ohne Prüfung: ein exakt verglichener Wert,
// der in den Daten nie vorkommt («hoch» statt «kritisch»), liefert eine leere Liste,
// und ein verworfener ungültiger Enum-Wert liefert die ungefilterte. Beides liest
// das Modell als Befund («keine schweren Widersprüche», «alle offen»). Darum nennt
// das Ergebnis dann die Werte, die es tatsächlich gibt.

/** Werte mit Anzahl als Text, häufigste zuerst: «kritisch (3), mittel (5)». */
function _formatValues(counts) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v, n]) => `${v} (${n})`).join(', ');
}

/** Normalisierter Filterwert (getrimmt, klein) oder null, wenn kein Filter gesetzt. */
function filterValue(v) {
  if (typeof v !== 'string') return null;
  const s = _lc(v);
  return s || null;
}

/** Text-Filter gegen die Werte, die in den Daten vorkommen (`values`: ein Wert je
 *  Zeile, Duplikate zählen). Kommt `value` darunter nicht vor, Rückgabe
 *  `{ hint, available_values }` für ein leeres Ergebnis, sonst null. Kein Fehler:
 *  ein gültiger, aber im Buch fehlender Wert ist von einem falschen nicht zu
 *  unterscheiden, und «gibt es nicht» ist dann die richtige Antwort. */
function filterMiss(param, value, values) {
  const want = filterValue(value);
  if (!want) return null;
  const counts = {};
  for (const raw of values || []) {
    const v = filterValue(raw);
    if (v) counts[v] = (counts[v] || 0) + 1;
  }
  if (want in counts) return null;
  const list = _formatValues(counts);
  return {
    hint: `${param}=«${value}» kommt nicht vor${list ? ` — vorhanden: ${list}. Mit einem dieser Werte erneut aufrufen` : ''}.`,
    available_values: counts,
  };
}

/** Enum-Filter: `value` (gesetzt) muss einer der `allowed` sein. Sonst ein
 *  invalidParam-Fehler mit den gültigen Werten, statt den Filter still zu
 *  verwerfen und ungefiltert zu antworten. null = gültig oder nicht gesetzt. */
function invalidEnum(param, value, allowed) {
  if (value == null || value === '') return null;
  if (allowed.includes(value)) return null;
  return {
    error: `Unbekannter Wert ${param}=«${value}». Gültige Werte: ${allowed.join(', ')}.`,
    errorKey: 'chat.toolError.invalidParam',
    errorParams: { param },
  };
}

// ── Analyse-Stand ────────────────────────────────────────────────────────────
// Figuren, Szenen, Orte, Zeitstrahl, Welt-Fakten und Songs sind ein Abzug der
// letzten Komplettanalyse. Was danach geschrieben wurde, fehlt — ohne Hinweis liest
// das Modell «kommt nicht vor» als Befund über den heutigen Text. Der Stand steht im
// Ergebnis statt in der Beschreibung: dort kostet er nur, wenn das Werkzeug läuft.

/** Felder für ein Katalog-Ergebnis (zum Spreaden vor die Listen): `analyse_stand`
 *  (Ende des letzten erfolgreichen Laufs) und, wenn seither Abschnitte bearbeitet
 *  wurden, `analyse_hinweis`. Ohne Lauf {}. */
function analysisStand(ctx) {
  const at = lastKomplettRun(ctx.bookId, ctx.userEmail || null)?.ended_at;
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return {};
  const changed = listPageNamesForBook(ctx.bookId).filter(p => Date.parse(p.updated_at) > t).length;
  return {
    analyse_stand: at,
    ...(changed ? { analyse_hinweis: `${changed} Abschnitt(e) seit der Analyse bearbeitet — was dort neu ist, fehlt hier. Für Neues den Text selbst prüfen.` } : {}),
  };
}

// ── Namens-Lookup ────────────────────────────────────────────────────────────
// Namen kommen vom Modell. SQLite-LIKE ignoriert Gross/Klein nur für ASCII
// («ärger» träfe «Ärger» nicht) und liest `%`/`_` als Platzhalter — darum der
// Vergleich in JS mit toLocaleLowerCase über die (kleine) Liste eines Buchs.
// Rangfolge: exakt > Wortanfang > Teilstring. Passen auf der besten Stufe mehrere
// Einträge, wird nicht still der erste genommen («Ann» fände sonst «Hannah»):
// das Ergebnis trägt dann `ambiguous` mit den Kandidaten.

const _lc = (v) => String(v ?? '').trim().toLocaleLowerCase('de');

function _nameRank(value, needle) {
  const h = _lc(value);
  if (!h) return 9;
  if (h === needle) return 0;
  if (h.split(/[\s\-–—_/.,()«»"']+/).some(w => w && w.startsWith(needle))) return 1;
  return h.includes(needle) ? 2 : 9;
}

/** Eintrag aus `rows` per Name. `fields` = Feldnamen, die als Name gelten (bester
 *  Rang über alle Felder zählt). Rückgabe `{ row }` (eindeutig), `{ row: null,
 *  ambiguous: [...] }` (mehrere auf derselben besten Stufe ausser exakt) oder
 *  `{ row: null }` (kein Treffer). Mehrere exakte Treffer → der erste (Reihenfolge
 *  der Eingabe). */
function findByName(rows, needle, fields = ['name']) {
  const n = _lc(needle);
  if (!n) return { row: null };
  let best = 9;
  let hits = [];
  for (const r of rows || []) {
    const rank = Math.min(...fields.map(f => _nameRank(r?.[f], n)));
    if (rank === 9 || rank > best) continue;
    if (rank < best) { best = rank; hits = []; }
    hits.push(r);
  }
  if (!hits.length) return { row: null };
  if (hits.length === 1 || best === 0) return { row: hits[0] };
  return { row: null, ambiguous: hits };
}

/** Fehler-Ergebnis für einen mehrdeutigen Namen: Kandidaten (per `candidateFn`
 *  geformt, höchstens 10) und der Hinweis, per ID erneut aufzurufen. */
function ambiguousNameError(needle, candidates, candidateFn, idParam) {
  return {
    error: `Name «${needle}» ist mehrdeutig — ${candidates.length} Einträge passen.`,
    errorKey: 'chat.toolError.ambiguousName',
    errorParams: { name: String(needle ?? '') },
    candidates: candidates.slice(0, 10).map(candidateFn),
    hint: `Mit ${idParam} aus den Kandidaten erneut aufrufen.`,
  };
}

// ── Scope-Prüfung ────────────────────────────────────────────────────────────

/** Prüft `chapterId`/`pageId` (je null/undefined = kein Filter) gegen das Buch des
 *  laufenden Chats (ctx.bookId). Rückgabe null (alles im Buch) oder das
 *  Fehler-Ergebnis für den Handler. Ohne die Prüfung liefert ein Filter auf eine
 *  fremde/erfundene ID still eine leere Liste — und das Modell liest «nichts da»
 *  als Befund. Synchron über die Namens-Lookups aus db/content-names.js (dort liegt
 *  der lesende Zugriff auf pages/chapters für Handler), damit die Handler ihre
 *  Signatur behalten. */
function assertScope(ctx, { chapterId = null, pageId = null } = {}) {
  if (chapterId != null && !listChaptersForBook(ctx.bookId).some(c => c.chapter_id === chapterId)) {
    return { error: `Kapitel ${chapterId} nicht im aktuellen Buch.`, errorKey: 'chat.toolError.chapterNotInBook', errorParams: { id: chapterId } };
  }
  if (pageId != null && pageTitle(pageId)?.book_id !== ctx.bookId) {
    return { error: `Abschnitt ${pageId} nicht im aktuellen Buch.`, errorKey: 'chat.toolError.pageNotInBook', errorParams: { id: pageId } };
  }
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
  clampInt,
  clip,
  groupBy,
  filterValue,
  filterMiss,
  invalidEnum,
  analysisStand,
  findByName,
  ambiguousNameError,
  assertScope,
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
  offered,
  toolHint,
  offeredList,
};
