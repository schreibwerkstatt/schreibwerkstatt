'use strict';
// search_similar — semantische Ähnlichkeitssuche über die Embedding-Vektoren
// (semantic_chunks). Gegenstück zu search_passages (tools-text.js): findet nach
// BEDEUTUNG, nicht nach Wortlaut. Eigenes Modul, weil Snippet-Zentrierung und
// Offset-Rückrechnung in den Seitentext eigene Helfer brauchen.

const contentStore = require('../../../lib/content-store');
const { htmlToPlainText } = require('../../../lib/html-text');
const embed = require('../../../lib/embed');
const semanticRetrieval = require('../../../lib/semantic-retrieval');
const { _truncateResult, resolveEntityTitle } = require('./shared');
const { getPageWithChapter } = require('../../../db/book-chat/text');

// Snippet-Länge pro Treffer. Ein Chunk ist ~1500 Zeichen (lib/embed-chunk.js#CHUNK_CHARS).
// Bewusst gross: ein zu kurzes Snippet ist nur ein Zeiger, nach dem das Modell die
// Seite per get_pages nachladen MUSS — und dieser Volltext kostet ein Vielfaches der
// Passage, die die Frage schon beantwortet hätte. _truncateResult deckelt die
// Gesamtantwort weiterhin.
const SIMILAR_SNIPPET_CHARS     = 700;
const SIMILAR_SNIPPET_MAX_CHARS = 1500;

// Buch-Kinds (Default) + Recherche-Material (nur auf ausdrücklichen Wunsch: Fremd-
// text aus Quellen/Notizen, keine Aussage des Buchs).
const BOOK_KINDS = ['page', 'scene', 'figure', 'location', 'fact'];
const ALLOWED_KINDS = [...BOOK_KINDS, 'research'];

// Inhaltswörter der Anfrage, auf 5 Zeichen gekürzt — grobes Stemming, damit
// „Abschied"/„Abschiede"/„abschieden" dasselbe Signal geben.
function _queryStems(query) {
  return Array.from(new Set(
    String(query || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
      .filter(w => w.length >= 4)
      .map(w => w.slice(0, 5)),
  ));
}

/**
 * Ausschnitt eines Treffer-Chunks: passt der Chunk in `maxChars`, der ganze Chunk;
 * sonst ein Fenster um den Satz mit den meisten Anfrage-Stämmen (ohne Treffer: der
 * Chunk-Anfang — dort beginnt beim Chunking eine Satzgrenze). Pure, unit-getestet.
 * @returns {{ snippet: string, start: number, end: number }} start/end im Chunk
 */
function centeredSnippet(text, query, maxChars) {
  const t = String(text || '');
  if (t.length <= maxChars) return { snippet: t, start: 0, end: t.length };
  const stems = _queryStems(query);
  let best = null;
  if (stems.length) {
    const re = /[^.!?…]+[.!?…]*["»«“”']*\s*/gu;
    let m;
    while ((m = re.exec(t)) !== null) {
      if (!m[0]) { re.lastIndex++; continue; }
      const lc = m[0].toLowerCase();
      const score = stems.reduce((n, s) => n + (lc.includes(s) ? 1 : 0), 0);
      if (score > 0 && (!best || score > best.score)) best = { score, start: m.index, end: m.index + m[0].length };
    }
  }
  let start = 0;
  if (best) {
    const mid = Math.floor((best.start + best.end) / 2);
    start = Math.max(0, Math.min(t.length - maxChars, mid - Math.floor(maxChars / 2)));
    // Auf Wortgrenze vorrücken (nicht mitten im Wort beginnen).
    if (start > 0) {
      const sp = t.indexOf(' ', start);
      if (sp >= 0 && sp - start < 40) start = sp + 1;
    }
  }
  let end = Math.min(t.length, start + maxChars);
  if (end < t.length) {
    const sp = t.lastIndexOf(' ', end);
    if (sp > start && end - sp < 40) end = sp;
  }
  const core = t.slice(start, end).trim();
  return {
    snippet: `${start > 0 ? '…' : ''}${core}${end < t.length ? '…' : ''}`,
    start, end,
  };
}

/**
 * Position eines Index-Ausschnitts im aktuellen Seitentext (htmlToPlainText, wie
 * quote_passage). Der Chunk ist whitespace-kollabiert, der Seitentext nicht —
 * gesucht wird darum auf einer kollabierten Kopie mit Rückabbildung der Offsets.
 * Erst der ganze Ausschnitt, sonst sein Anfang (die Seite kann seit dem Indexlauf
 * am Ende des Ausschnitts editiert worden sein). Pure, unit-getestet.
 * @returns {{ offset: number, length: number } | null}
 */
function locateInPageText(pageText, needle) {
  const src = String(pageText || '');
  const map = [];
  let norm = '';
  let lastSpace = true;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      if (lastSpace) continue;
      norm += ' '; map.push(i); lastSpace = true;
    } else {
      norm += ch; map.push(i); lastSpace = false;
    }
  }
  const n = String(needle || '').replace(/\s+/g, ' ').trim();
  if (n.length < 20) return null;
  let at = norm.indexOf(n);
  let len = n.length;
  if (at < 0) {
    const probe = n.slice(0, Math.min(80, Math.max(20, Math.floor(n.length / 2)))).trimEnd();
    at = norm.indexOf(probe);
    len = probe.length;
    if (at < 0) return null;
  }
  const offset = map[at];
  const endIdx = map[at + len - 1] + 1;
  return { offset, length: endIdx - offset };
}

async function tool_search_similar(input, ctx) {
  if (!embed.isEnabled()) return { error: 'Embedding-Backend nicht konfiguriert.', errorKey: 'chat.toolError.semanticUnavailable' };
  const query = (input.query || '').trim();
  if (!query) return { error: 'query fehlt', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'query' } };
  const kinds = Array.isArray(input.kinds) && input.kinds.length
    ? input.kinds.filter(k => ALLOWED_KINDS.includes(k)) : BOOK_KINDS;
  if (!kinds.length) return { error: `kinds: erlaubt sind ${ALLOWED_KINDS.join(', ')}.`, errorKey: 'chat.toolError.invalidParam', errorParams: { param: 'kinds' } };
  const topK = Math.min(Math.max(1, input.limit || 20), 50);

  // Volle Qualitäts-Pipeline (Retrieval → Hybrid-Fusion → Reranking), damit der
  // agentische Chat dieselben scharfen Treffer bekommt wie die Such-Karte — inkl.
  // mehrerer getrennter Passagen je Abschnitt (ein Kapitel am Stück hätte sonst nur
  // eine Fundstelle). Ein Abbruch ist kein Werkzeug-Fehler: weiterwerfen.
  let raw;
  try {
    raw = await semanticRetrieval.semanticQuery(ctx.bookId, query, {
      kinds, topK, signal: ctx.jobSignal, perEntity: semanticRetrieval.PASSAGES_PER_ENTITY,
    });
  }
  catch (e) {
    if (e?.name === 'AbortError') throw e;
    return { error: `Embedding-Endpunkt nicht erreichbar: ${e.message}`, errorKey: 'chat.toolError.semanticUnavailable' };
  }

  const snippetChars = Math.min(
    Math.max(120, Number.isInteger(input.snippet_chars) ? input.snippet_chars : SIMILAR_SNIPPET_CHARS),
    SIMILAR_SNIPPET_MAX_CHARS,
  );

  const pageTexts = new Map(); // page_id → Plaintext (eine Ladung pro Seite)
  const results = [];
  for (const h of raw) {
    // User-Scope: Szenen/Figuren/Orte/Fakten anderer Mitautoren fallen weg.
    const title = resolveEntityTitle(h.kind, h.entity_id, { userEmail: ctx.userEmail ?? null });
    if (title == null) continue; // gelöschte Entität → überspringen
    const { snippet, start, end } = centeredSnippet(h.text, query, snippetChars);
    const r = { kind: h.kind, entity_id: h.entity_id, title, snippet, score: Math.round(h.score * 1000) / 1000 };
    if (h.kind === 'page') {
      const row = getPageWithChapter(h.entity_id);
      if (!row || row.book_id !== ctx.bookId) continue; // Geister-Chunk eines fremden Buchs
      if (row.chapter_name) r.chapter_name = row.chapter_name;
      if (ctx.jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (!pageTexts.has(h.entity_id)) {
        let text = null;
        try { text = htmlToPlainText((await contentStore.loadPage(h.entity_id)).html || ''); }
        catch (e) { if (e?.name === 'AbortError') throw e; }
        pageTexts.set(h.entity_id, text);
      }
      const loc = pageTexts.get(h.entity_id) != null
        ? locateInPageText(pageTexts.get(h.entity_id), String(h.text || '').slice(start, end))
        : null;
      if (loc) { r.offset = loc.offset; r.length = loc.length; }
    }
    results.push(r);
  }
  return _truncateResult({ query, count: results.length, results });
}

module.exports = { tool_search_similar, centeredSnippet, locateInPageText };
