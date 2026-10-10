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
  resultCapFor,
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
  if (!pattern) return { error: 'pattern fehlt', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'pattern' } };
  const isRegex = !!input.regex;
  const maxResults = Math.min(Math.max(1, input.max_results || 10), MAX_SEARCH_RESULTS);

  let re;
  try { re = _buildSearchRegex(pattern, isRegex); }
  catch (e) { return { error: `Ungueltiges Regex-Muster: ${e.message}`, errorKey: 'chat.toolError.invalidParam', errorParams: { param: 'pattern' } }; }

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
      ? { note: 'Keine indizierten Abschnitte im Buch — Reindex oder Sync ausfuehren.' }
      : {}),
  });
}

// ── Seiten-Fenster (get_pages / get_chapter_text) ─────────────────────────────

// Lange Abschnitte (ein Kapitel am Stück, 20–60k Zeichen) passen nicht in ein
// Werkzeug-Ergebnis. Statt nur den Anfang zu liefern, gibt es ein Fenster ab
// `offset` (Zeichen im zurückgegebenen Text) und `next_offset` zum Weiterlesen.
// Der Schnitt fällt auf eine Wortgrenze, wenn eine in den letzten
// WINDOW_WORD_SNAP Zeichen liegt. Pure, unit-getestet.
const WINDOW_WORD_SNAP = 200;

function pageWindow(text, offset, maxChars) {
  const t = String(text || '');
  const total = t.length;
  const start = Math.min(Math.max(0, Number.isInteger(offset) ? offset : 0), total);
  let end = Math.min(total, start + Math.max(1, maxChars));
  let next = end;
  if (end < total) {
    const sp = t.lastIndexOf(' ', end);
    if (sp > start && end - sp <= WINDOW_WORD_SNAP) { end = sp; next = sp + 1; }
  }
  return {
    text: t.slice(start, end),
    ...(start > 0 ? { offset: start } : {}),
    page_chars: total,
    truncated: end < total,
    ...(end < total ? { next_offset: next } : {}),
    ...(Number.isInteger(offset) && offset >= total && total > 0 ? { offset_beyond_end: true } : {}),
  };
}

// Text-Deckel pro Abschnitt. Höchstens so viel, dass EIN Abschnitt samt Metadaten
// unter den Ergebnis-Deckel des Loops passt: sonst kürzte _truncateResult den
// Text nachträglich (Stufe 2), und next_offset zeigte hinter Text, den das Modell
// nie gesehen hat. Mehrere Abschnitte kürzt der Deckel über das pages-Array
// (ganze Abschnitte fallen weg, truncated_fields meldet es) — der Text bleibt exakt.
const WINDOW_META_RESERVE = 1500;
function _perPageChars(requested, ctx) {
  const fitCap = Math.floor((resultCapFor(ctx) - WINDOW_META_RESERVE) * 0.9);
  const want = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_CHARS_PER_PAGE;
  return Math.max(500, Math.min(MAX_CHARS_PER_PAGE, fitCap, Math.max(500, want)));
}

const WINDOW_HINT = 'Mindestens ein Abschnitt ist gekürzt (truncated) — mit offset=next_offset weiterlesen.';

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
  if (!ids.length) return { error: 'ids fehlen oder leer', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'ids' } };
  const limit = Math.min(MAX_PAGES_PER_FETCH, ids.length);
  const maxChars = _perPageChars(input.max_chars_per_page, ctx);
  const offset = Number.isInteger(input.offset) && input.offset > 0 ? input.offset : 0;
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
      missing.push({ page_id: pageId, error: 'Abschnitt nicht im aktuellen Buch.' });
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
        ...pageWindow(text, offset, maxChars),
        ...(latestCheck ? { latest_check: latestCheck } : {}),
      });
    } catch (e) {
      missing.push({ page_id: pageId, error: e.message });
    }
  }
  const dropped = ids.length - toFetch.length;
  return _truncateResult({
    ...(results.some(r => r.truncated) ? { hint: WINDOW_HINT } : {}),
    pages: results,
    ...(missing.length ? { missing } : {}),
    ...(dropped > 0 ? { dropped, note: `${dropped} weitere IDs ignoriert (max ${MAX_PAGES_PER_FETCH} pro Aufruf).` } : {}),
  });
}

// ── get_chapter_text ─────────────────────────────────────────────────────────

async function tool_get_chapter_text(input, ctx) {
  const chapterId = input?.chapter_id;
  if (!Number.isInteger(chapterId)) return { error: 'chapter_id fehlt', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'chapter_id' } };
  const chapter = getChapterInBook(chapterId, ctx.bookId);
  if (!chapter) return { error: 'Kapitel nicht im aktuellen Buch.', errorKey: 'chat.toolError.chapterNotInBook' };

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
  const maxCharsPerPage = _perPageChars(input?.max_chars_per_page, ctx);
  const offset = Number.isInteger(input?.offset) && input.offset > 0 ? input.offset : 0;
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
        ...pageWindow(text, offset, maxCharsPerPage),
      });
    } catch (e) {
      missing.push({ page_id: row.page_id, error: e.message });
    }
  }

  return _truncateResult({
    chapter_id:   chapter.chapter_id,
    chapter_name: chapter.chapter_name,
    total_pages:  pageRows.length,
    ...(results.some(r => r.truncated) ? { hint: WINDOW_HINT } : {}),
    pages:        results,
    ...(missing.length ? { missing } : {}),
    ...(dropped > 0 ? { dropped, note: `${dropped} weitere Abschnitte nicht geladen (max ${maxPages}).` } : {}),
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
  if (!Number.isInteger(pageId)) return { error: 'page_id fehlt', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'page_id' } };
  if (!Number.isInteger(offset) || offset < 0) return { error: 'offset (>= 0) fehlt', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'offset' } };
  if (!Number.isInteger(length) || length <= 0) return { error: 'length (> 0) fehlt', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'length' } };
  if (length > QUOTE_MAX_LENGTH) return { error: `length zu gross (max ${QUOTE_MAX_LENGTH}).`, errorKey: 'chat.toolError.invalidParam', errorParams: { param: 'length' } };

  const contextChars = Math.min(QUOTE_MAX_CONTEXT, Math.max(0, Number.isInteger(input?.context_chars) ? input.context_chars : QUOTE_DEFAULT_CONTEXT));

  const pageRow = getPageWithChapter(pageId);
  if (!pageRow || pageRow.book_id !== ctx.bookId) {
    return { error: 'Abschnitt nicht im aktuellen Buch.', errorKey: 'chat.toolError.pageNotInBook' };
  }
  if (ctx.jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const pd = await contentStore.loadPage(pageId);
  const text = htmlToPlainText(pd.html || '');
  if (offset >= text.length) {
    return { error: `offset (${offset}) liegt ausserhalb des Texts (Laenge ${text.length}).`, errorKey: 'chat.toolError.invalidParam', errorParams: { param: 'offset' } };
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
  if (!Number.isInteger(pageId)) return { error: 'page_id fehlt', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'page_id' } };
  if (!pattern)                  return { error: 'pattern fehlt', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'pattern' } };
  if (pattern.length > QUOTE_MATCH_MAX_PATTERN) {
    return { error: `pattern zu lang (max ${QUOTE_MATCH_MAX_PATTERN}).`, errorKey: 'chat.toolError.invalidParam', errorParams: { param: 'pattern' } };
  }
  const occurrence   = Number.isInteger(input?.occurrence) && input.occurrence >= 1 ? input.occurrence : 1;
  const contextChars = Math.min(QUOTE_MAX_CONTEXT, Math.max(0,
    Number.isInteger(input?.context_chars) ? input.context_chars : QUOTE_MATCH_DEFAULT_CONTEXT));

  const pageRow = getPageWithChapter(pageId);
  if (!pageRow || pageRow.book_id !== ctx.bookId) {
    return { error: 'Abschnitt nicht im aktuellen Buch.', errorKey: 'chat.toolError.pageNotInBook' };
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
      error: 'pattern nicht gefunden.', errorKey: 'chat.toolError.patternNotFound',
      page_id:    pageId,
      page_chars: text.length,
      total_matches: 0,
    };
  }
  if (occurrence > indices.length) {
    return {
      error: `Nur ${indices.length} Treffer im Abschnitt (occurrence=${occurrence}).`, errorKey: 'chat.toolError.patternNotFound',
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
    if (!figRow) return { error: 'Figur nicht gefunden', errorKey: 'chat.toolError.figureNotFound' };
    figNames = _figureNamePatterns(figRow).map(n => n.toLowerCase());
  }

  const pages = listPagesForDialogue(ctx.bookId, {
    chapterId: Number.isInteger(input?.chapter_id) ? input.chapter_id : null,
    pageId:    Number.isInteger(input?.page_id)    ? input.page_id    : null,
  });
  if (!pages.length) return { results: [], hint: 'Keine Abschnitte im Scope.' };

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
    return { error: 'figur_id, figur_name oder loc_id erforderlich.', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'figur_id/figur_name/loc_id' } };
  }

  if (hasFigSelector) {
    const figRow = _findFigure(input, ctx);
    if (!figRow) {
      return { error: 'Figur nicht gefunden', errorKey: 'chat.toolError.figureNotFound', hint: 'Pruefe die Figurenliste im System-Prompt.' };
    }
    const mentions = listFigureMentionsWithPages(figRow.id, ctx.bookId);
    if (!mentions.length) {
      return {
        fig_id: figRow.fig_id,
        name: figRow.name,
        error: 'Keine Index-Erwaehnung vorhanden. Komplettanalyse/Sync ausfuehren.', errorKey: 'chat.toolError.noIndex',
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
    return { error: 'Ort nicht gefunden', errorKey: 'chat.toolError.locationNotFound', hint: 'Pruefe loc_id via list_locations.' };
  }
  const chRows = listLocationChaptersWithNames(locRow.id);
  if (!chRows.length) {
    return {
      loc_id: locRow.loc_id,
      name: locRow.name,
      error: 'Keine Index-Erwaehnung vorhanden. Komplettanalyse/Sync ausfuehren.', errorKey: 'chat.toolError.noIndex',
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
  pageWindow,
};
