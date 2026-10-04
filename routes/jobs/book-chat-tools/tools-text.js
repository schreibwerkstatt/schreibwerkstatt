'use strict';
// Text-fokussierte Tools: Seiten + Kapiteltexte laden, Volltext-/Regex-Suche,
// Zitate via Offset oder Pattern, Dialogerkennung, Erst-/Letztauftritt. Die
// semantische Suche (search_similar) liegt in tools-similar.js.

const { htmlToText } = require('../shared');
const contentStore = require('../../../lib/content-store');
const { htmlToPlainText } = require('../../../lib/html-text');
const { findDialogRanges } = require('../../../lib/page-index');
const searchIndex = require('../../../lib/search');
const semanticRetrieval = require('../../../lib/semantic-retrieval');
const {
  MAX_CHARS_PER_PAGE,
  DEFAULT_CHARS_PER_PAGE,
  MAX_SEARCH_RESULTS,
  MAX_PAGES_PER_FETCH,
  SEARCH_SNIPPET_CONTEXT,
  _truncateResult,
  _findFigure,
} = require('./shared');
const {
  listPagesForPassageSearch,
  getPageWithChapter,
  getChapterInBook,
  listChapterPages,
  listPagesForDialogue,
  getLatestPageCheck,
  getLocationRefByLocId,
  listLocationChaptersWithNames,
} = require('../../../db/book-chat/text');
const { listFigureMentionsWithPages } = require('../../../db/book-chat/figures');

// ── search_passages ───────────────────────────────────────────────────────────

function _buildSearchRegex(pattern, regex) {
  if (!regex) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped, 'gi');
  }
  return new RegExp(pattern, 'gi');
}

// Maximale Anzahl Kandidaten-Seiten aus FTS5. bm25-sortiert; 200 reicht für
// Buch-weite Suchen mit eindeutigen Begriffen.
const SEARCH_FTS_CANDIDATE_LIMIT = 200;

// Pro Kandidatenseite an den Reranker gegebener Volltext-Ausschnitt. Deckelt die
// Payload — der Cross-Encoder braucht keinen ganzen Kapitelroman, um die Relevanz
// zu einem Suchmuster einzuschätzen.
const RERANK_DOC_MAXCHARS = 2000;

async function tool_search_passages(input, ctx) {
  const pattern = (input.pattern || '').trim();
  if (!pattern) return { error: 'pattern fehlt' };
  const isRegex = !!input.regex;
  const maxResults = Math.min(Math.max(1, input.max_results || 10), MAX_SEARCH_RESULTS);

  let re;
  try { re = _buildSearchRegex(pattern, isRegex); }
  catch (e) { return { error: `Ungueltiges Regex-Muster: ${e.message}` }; }

  // FTS5 verengt nur den Literal-Pfad; Regex muss alle Buchseiten scannen.
  let candidatePageIds = null;
  let ftsUsed = false;
  if (!isRegex) {
    const { hits } = searchIndex.query(pattern, {
      bookId: ctx.bookId,
      kinds:  ['page'],
      limit:  SEARCH_FTS_CANDIDATE_LIMIT,
    });
    candidatePageIds = hits.map(h => h.entity_id);
    ftsUsed = true;
    if (!candidatePageIds.length) {
      return _truncateResult({
        pattern,
        regex: false,
        fts: true,
        results: [],
        note: 'Keine FTS5-Treffer im Buch.',
      });
    }
  }

  const pages = listPagesForPassageSearch(ctx.bookId, {
    chapterId: Number.isInteger(input.chapter_id) ? input.chapter_id : null,
    pageId:    Number.isInteger(input.page_id)    ? input.page_id    : null,
    pageIds:   candidatePageIds,
  });

  let orderedPages = pages;
  if (candidatePageIds) {
    const rank = new Map(candidatePageIds.map((id, i) => [id, i]));
    orderedPages = pages.slice().sort((a, b) => (rank.get(a.page_id) ?? Infinity) - (rank.get(b.page_id) ?? Infinity));

    // Reranking (falls aktiv): den bm25-Kandidatenpool per Cross-Encoder gegen
    // das Suchmuster nach Bedeutung umsortieren, bevor gescannt wird. Bei
    // natürlichsprachlichen Mustern landen so die relevantesten Seiten zuerst im
    // Scan (wichtig wegen max_results-/Deadline-Cut). Die Literal-/Regex-Treffer
    // bleiben unangetastet — es wird nur die Scan-Reihenfolge geschärft, nichts
    // verworfen. Non-fatal: Endpunkt aus/nicht erreichbar → bm25-Reihenfolge.
    const order = await semanticRetrieval.rerankOrder(
      pattern,
      orderedPages.map(p => htmlToPlainText(p.body_html || '').slice(0, RERANK_DOC_MAXCHARS)),
      { signal: ctx.jobSignal },
    );
    if (order) orderedPages = order.map(i => orderedPages[i]);
  }

  const results = [];
  const deadline = Date.now() + 3000;

  outer: for (const p of orderedPages) {
    if (Date.now() > deadline) break;
    if (ctx.jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const text = htmlToPlainText(p.body_html || '');
    if (!text) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = Math.max(0, m.index - SEARCH_SNIPPET_CONTEXT);
      const end   = Math.min(text.length, m.index + m[0].length + SEARCH_SNIPPET_CONTEXT);
      results.push({
        page_id:   p.page_id,
        page_name: p.page_name,
        chapter_id: p.chapter_id,
        offset:    m.index,
        match:     m[0],
        snippet:   (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : ''),
      });
      if (results.length >= maxResults) break outer;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }

  return _truncateResult({
    pattern,
    regex: isRegex,
    ...(ftsUsed ? { fts: true } : {}),
    ...(Number.isInteger(input.chapter_id) ? { chapter_id: input.chapter_id } : {}),
    ...(Number.isInteger(input.page_id)    ? { page_id:    input.page_id    } : {}),
    results,
    ...(orderedPages.length === 0
      ? { note: 'Keine indizierten Seiten im Buch — Reindex oder Sync ausfuehren.' }
      : {}),
  });
}

// ── get_pages ─────────────────────────────────────────────────────────────────

const LATEST_CHECK_STILANALYSE_CHARS = 600;

function _latestCheckForPage(pageId, userEmail) {
  const row = getLatestPageCheck(pageId, userEmail || null);
  if (!row) return null;
  const stil = row.stilanalyse || null;
  return {
    checked_at:  row.checked_at,
    error_count: row.error_count ?? 0,
    fazit:       row.fazit || null,
    stilanalyse: stil && stil.length > LATEST_CHECK_STILANALYSE_CHARS
      ? stil.slice(0, LATEST_CHECK_STILANALYSE_CHARS) + '…'
      : stil,
    model:       row.model || null,
  };
}

async function tool_get_pages(input, ctx) {
  const ids = Array.isArray(input.ids) ? input.ids.filter(n => Number.isInteger(n)) : [];
  if (!ids.length) return { error: 'ids fehlen oder leer' };
  const limit = Math.min(MAX_PAGES_PER_FETCH, ids.length);
  const maxChars = Math.min(MAX_CHARS_PER_PAGE, Math.max(500, input.max_chars_per_page || DEFAULT_CHARS_PER_PAGE));
  const toFetch = ids.slice(0, limit);
  const results = [];
  const missing = [];
  for (const pageId of toFetch) {
    if (ctx.jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // Buch-Scope VOR dem Laden: die ids kommen vom Modell (und damit indirekt aus
    // jeder Userfrage). Eine Seite eines fremden Buchs wird wie eine fehlende gemeldet
    // — ohne Inhalt und ohne Hinweis, dass sie existiert.
    const pageRow = getPageWithChapter(pageId);
    if (!pageRow || pageRow.book_id !== ctx.bookId) {
      missing.push({ page_id: pageId, error: 'Seite nicht im aktuellen Buch.' });
      continue;
    }
    try {
      const pd = await contentStore.loadPage(pageId);
      const text = htmlToText(pd.html || '');
      const latestCheck = _latestCheckForPage(pageId, ctx.userEmail);
      results.push({
        page_id: pageId,
        page_name: pageRow?.page_name || pd.name || `#${pageId}`,
        chapter_name: pageRow?.chapter_name || null,
        text: text.length > maxChars ? text.slice(0, maxChars) + '…' : text,
        truncated: text.length > maxChars,
        ...(latestCheck ? { latest_check: latestCheck } : {}),
      });
    } catch (e) {
      missing.push({ page_id: pageId, error: e.message });
    }
  }
  const dropped = ids.length - toFetch.length;
  return _truncateResult({
    pages: results,
    ...(missing.length ? { missing } : {}),
    ...(dropped > 0 ? { dropped, note: `${dropped} weitere IDs ignoriert (max ${MAX_PAGES_PER_FETCH} pro Aufruf).` } : {}),
  });
}

// ── get_chapter_text ─────────────────────────────────────────────────────────

async function tool_get_chapter_text(input, ctx) {
  const chapterId = input?.chapter_id;
  if (!Number.isInteger(chapterId)) return { error: 'chapter_id fehlt' };
  const chapter = getChapterInBook(chapterId, ctx.bookId);
  if (!chapter) return { error: 'Kapitel nicht im aktuellen Buch.' };

  const pageRows = listChapterPages(chapterId, ctx.bookId);
  if (!pageRows.length) {
    return {
      chapter_id:   chapter.chapter_id,
      chapter_name: chapter.chapter_name,
      pages:        [],
      total_pages:  0,
    };
  }

  const maxPages = Math.min(MAX_PAGES_PER_FETCH,
    Math.max(1, Number.isInteger(input?.max_pages) ? input.max_pages : pageRows.length));
  const maxCharsPerPage = Math.min(MAX_CHARS_PER_PAGE,
    Math.max(500, Number.isInteger(input?.max_chars_per_page) ? input.max_chars_per_page : DEFAULT_CHARS_PER_PAGE));
  const toFetch = pageRows.slice(0, maxPages);
  const dropped = pageRows.length - toFetch.length;

  const results = [];
  const missing = [];
  for (const row of toFetch) {
    if (ctx.jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const pd = await contentStore.loadPage(row.page_id);
      const text = htmlToText(pd.html || '');
      results.push({
        page_id:   row.page_id,
        page_name: row.page_name,
        text:      text.length > maxCharsPerPage ? text.slice(0, maxCharsPerPage) + '…' : text,
        truncated: text.length > maxCharsPerPage,
      });
    } catch (e) {
      missing.push({ page_id: row.page_id, error: e.message });
    }
  }

  return _truncateResult({
    chapter_id:   chapter.chapter_id,
    chapter_name: chapter.chapter_name,
    pages:        results,
    total_pages:  pageRows.length,
    ...(missing.length ? { missing } : {}),
    ...(dropped > 0 ? { dropped, note: `${dropped} weitere Seiten nicht geladen (max ${maxPages}).` } : {}),
  });
}

// ── quote_passage ─────────────────────────────────────────────────────────────

const QUOTE_DEFAULT_CONTEXT = 80;
const QUOTE_MAX_LENGTH      = 800;
const QUOTE_MAX_CONTEXT     = 300;

async function tool_quote_passage(input, ctx) {
  const pageId = input?.page_id;
  const offset = input?.offset;
  const length = input?.length;
  if (!Number.isInteger(pageId)) return { error: 'page_id fehlt' };
  if (!Number.isInteger(offset) || offset < 0) return { error: 'offset (>= 0) fehlt' };
  if (!Number.isInteger(length) || length <= 0) return { error: 'length (> 0) fehlt' };
  if (length > QUOTE_MAX_LENGTH) return { error: `length zu gross (max ${QUOTE_MAX_LENGTH}).` };

  const contextChars = Math.min(QUOTE_MAX_CONTEXT, Math.max(0, Number.isInteger(input?.context_chars) ? input.context_chars : QUOTE_DEFAULT_CONTEXT));

  const pageRow = getPageWithChapter(pageId);
  if (!pageRow || pageRow.book_id !== ctx.bookId) {
    return { error: 'Seite nicht im aktuellen Buch.' };
  }
  if (ctx.jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const pd = await contentStore.loadPage(pageId);
  const text = htmlToPlainText(pd.html || '');
  if (offset >= text.length) {
    return { error: `offset (${offset}) liegt ausserhalb des Texts (Laenge ${text.length}).` };
  }
  const end = Math.min(text.length, offset + length);
  const quote = text.slice(offset, end);
  const before = contextChars ? text.slice(Math.max(0, offset - contextChars), offset) : '';
  const after  = contextChars ? text.slice(end, Math.min(text.length, end + contextChars)) : '';

  return {
    page_id:      pageId,
    page_name:    pageRow.page_name,
    chapter_id:   pageRow.chapter_id || null,
    chapter_name: pageRow.chapter_name || null,
    offset,
    length:       end - offset,
    page_chars:   text.length,
    quote,
    ...(before ? { before } : {}),
    ...(after  ? { after  } : {}),
    ...(end - offset < length ? { clamped_to_eot: true } : {}),
  };
}

// ── quote_match ──────────────────────────────────────────────────────────────

const QUOTE_MATCH_DEFAULT_CONTEXT = 80;
const QUOTE_MATCH_MAX_PATTERN     = 800;

async function tool_quote_match(input, ctx) {
  const pageId  = input?.page_id;
  const pattern = (input?.pattern || '').toString();
  if (!Number.isInteger(pageId)) return { error: 'page_id fehlt' };
  if (!pattern)                  return { error: 'pattern fehlt' };
  if (pattern.length > QUOTE_MATCH_MAX_PATTERN) {
    return { error: `pattern zu lang (max ${QUOTE_MATCH_MAX_PATTERN}).` };
  }
  const occurrence   = Number.isInteger(input?.occurrence) && input.occurrence >= 1 ? input.occurrence : 1;
  const contextChars = Math.min(QUOTE_MAX_CONTEXT, Math.max(0,
    Number.isInteger(input?.context_chars) ? input.context_chars : QUOTE_MATCH_DEFAULT_CONTEXT));

  const pageRow = getPageWithChapter(pageId);
  if (!pageRow || pageRow.book_id !== ctx.bookId) {
    return { error: 'Seite nicht im aktuellen Buch.' };
  }
  if (ctx.jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const pd = await contentStore.loadPage(pageId);
  const text = htmlToPlainText(pd.html || '');

  const lcText = text.toLowerCase();
  const lcPat  = pattern.toLowerCase();
  const indices = [];
  for (let pos = 0; pos <= lcText.length - lcPat.length; ) {
    const found = lcText.indexOf(lcPat, pos);
    if (found < 0) break;
    indices.push(found);
    pos = found + lcPat.length;
    if (indices.length >= 5000) break;
  }
  if (indices.length === 0) {
    return {
      error: 'pattern nicht gefunden.',
      page_id:    pageId,
      page_chars: text.length,
      total_matches: 0,
    };
  }
  if (occurrence > indices.length) {
    return {
      error: `Nur ${indices.length} Treffer auf der Seite (occurrence=${occurrence}).`,
      page_id:    pageId,
      total_matches: indices.length,
    };
  }
  const idx    = indices[occurrence - 1];
  const length = pattern.length;
  const end    = idx + length;
  const quote  = text.slice(idx, end);
  const before = contextChars ? text.slice(Math.max(0, idx - contextChars), idx) : '';
  const after  = contextChars ? text.slice(end, Math.min(text.length, end + contextChars)) : '';

  return {
    page_id:      pageId,
    page_name:    pageRow.page_name,
    chapter_id:   pageRow.chapter_id || null,
    chapter_name: pageRow.chapter_name || null,
    offset:       idx,
    length,
    page_chars:   text.length,
    quote,
    occurrence,
    total_matches: indices.length,
    ...(before ? { before } : {}),
    ...(after  ? { after  } : {}),
  };
}

// ── get_dialogue ──────────────────────────────────────────────────────────────

const DIALOGUE_DEFAULT_LIMIT  = 30;
const DIALOGUE_MAX_LIMIT      = 100;
const DIALOGUE_CONTEXT_CHARS  = 80;
const DIALOGUE_SPEAKER_WINDOW = 100;

function _figureNamePatterns(figRow) {
  const names = [];
  if (figRow.name) names.push(figRow.name);
  if (figRow.kurzname && figRow.kurzname !== figRow.name) names.push(figRow.kurzname);
  return names;
}

function tool_get_dialogue(input, ctx) {
  const limit = Math.min(DIALOGUE_MAX_LIMIT, Math.max(1, Number.isInteger(input?.limit) ? input.limit : DIALOGUE_DEFAULT_LIMIT));
  const minLen = Math.max(1, Number.isInteger(input?.min_length) ? input.min_length : 4);

  let figRow = null;
  let figNames = null;
  if (input?.figur_id || input?.figur_name) {
    figRow = _findFigure(input, ctx);
    if (!figRow) return { error: 'Figur nicht gefunden' };
    figNames = _figureNamePatterns(figRow).map(n => n.toLowerCase());
  }

  const pages = listPagesForDialogue(ctx.bookId, {
    chapterId: Number.isInteger(input?.chapter_id) ? input.chapter_id : null,
    pageId:    Number.isInteger(input?.page_id)    ? input.page_id    : null,
  });
  if (!pages.length) return { results: [], hint: 'Keine Seiten im Scope.' };

  const results = [];
  let totalFound = 0;
  for (const p of pages) {
    const text = htmlToPlainText(p.body_html);
    const ranges = findDialogRanges(text);
    for (const [a, b] of ranges) {
      const segment = text.slice(a, b).trim();
      if (segment.length < minLen) continue;
      if (figNames) {
        const winStart = Math.max(0, a - DIALOGUE_SPEAKER_WINDOW);
        const winEnd   = Math.min(text.length, b + DIALOGUE_SPEAKER_WINDOW);
        const ctxLower = text.slice(winStart, winEnd).toLowerCase();
        if (!figNames.some(n => ctxLower.includes(n))) continue;
      }
      totalFound++;
      if (results.length >= limit) continue;
      const before = text.slice(Math.max(0, a - DIALOGUE_CONTEXT_CHARS), a).trim();
      const after  = text.slice(b, Math.min(text.length, b + DIALOGUE_CONTEXT_CHARS)).trim();
      results.push({
        page_id:    p.page_id,
        page_name:  p.page_name,
        chapter_id: p.chapter_id,
        offset:     a,
        length:     b - a,
        text:       segment,
        before:     before || null,
        after:      after  || null,
      });
    }
    if (results.length >= limit && !figNames) break;
  }

  return _truncateResult({
    ...(figRow ? { figur: { fig_id: figRow.fig_id, name: figRow.name } } : {}),
    results,
    total_results: totalFound,
    ...(totalFound > results.length ? { truncated: true, shown: results.length } : {}),
    hint: 'Heuristische Dialog-Erkennung (Anfuehrungszeichen, Speech-Verb+Doppelpunkt, Em-Dash). Einfache gerade Quotes werden ignoriert.',
  });
}

// ── find_first_last_mention ───────────────────────────────────────────────────

function tool_find_first_last_mention(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const hasFigSelector = (typeof input?.figur_id === 'string' && input.figur_id.trim())
                      || (typeof input?.figur_name === 'string' && input.figur_name.trim());
  const hasLocSelector = typeof input?.loc_id === 'string' && input.loc_id.trim();

  if (!hasFigSelector && !hasLocSelector) {
    return { error: 'figur_id, figur_name oder loc_id erforderlich.' };
  }

  if (hasFigSelector) {
    const figRow = _findFigure(input, ctx);
    if (!figRow) {
      return { error: 'Figur nicht gefunden', hint: 'Pruefe die Figurenliste im System-Prompt.' };
    }
    const mentions = listFigureMentionsWithPages(figRow.id, ctx.bookId);
    if (!mentions.length) {
      return {
        fig_id: figRow.fig_id,
        name: figRow.name,
        error: 'Keine Index-Erwaehnung vorhanden. Komplettanalyse/Sync ausfuehren.',
      };
    }
    const first = mentions[0];
    const last  = mentions[mentions.length - 1];
    const total = mentions.reduce((s, m) => s + m.count, 0);
    return {
      fig_id: figRow.fig_id,
      name: figRow.name,
      total_mentions: total,
      pages_with_mention: mentions.length,
      first_appearance: {
        chapter_id: first.chapter_id,
        chapter_name: first.chapter_name || '(ohne Kapitel)',
        page_id: first.page_id,
        page_name: first.page_name,
        first_offset: first.first_offset,
        count: first.count,
      },
      last_appearance: {
        chapter_id: last.chapter_id,
        chapter_name: last.chapter_name || '(ohne Kapitel)',
        page_id: last.page_id,
        page_name: last.page_name,
        count: last.count,
      },
    };
  }

  const locRow = getLocationRefByLocId(ctx.bookId, userEmail, input.loc_id.trim());
  if (!locRow) {
    return { error: 'Ort nicht gefunden', hint: 'Pruefe loc_id via list_locations.' };
  }
  const chRows = listLocationChaptersWithNames(locRow.id);
  if (!chRows.length) {
    return {
      loc_id: locRow.loc_id,
      name: locRow.name,
      error: 'Keine Index-Erwaehnung vorhanden. Komplettanalyse/Sync ausfuehren.',
    };
  }
  const first = chRows[0];
  const last  = chRows[chRows.length - 1];
  return {
    loc_id: locRow.loc_id,
    name: locRow.name,
    chapters_with_mention: chRows.length,
    first_appearance: {
      chapter_id: first.chapter_id,
      chapter_name: first.chapter_name || '(ohne Kapitel)',
      haeufigkeit: first.haeufigkeit,
    },
    last_appearance: {
      chapter_id: last.chapter_id,
      chapter_name: last.chapter_name || '(ohne Kapitel)',
      haeufigkeit: last.haeufigkeit,
    },
  };
}

module.exports = {
  tool_search_passages,
  tool_get_pages,
  tool_get_chapter_text,
  tool_quote_passage,
  tool_quote_match,
  tool_get_dialogue,
  tool_find_first_last_mention,
};
