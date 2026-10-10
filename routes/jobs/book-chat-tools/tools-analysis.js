'use strict';
// Analyse-Tools: Buch-/Kapitel-Reviews, Lektorat-Hotspots + Findings,
// Stil-Metriken (Buch/Kapitel/Seite), N-Gram-Wiederholungen.

const { htmlToPlainText } = require('../../../lib/html-text');
const { _truncateResult } = require('./shared');
const { listChaptersForBook } = require('../../../db/content-names');
const {
  STIL_METRIC_COLS,
  getLatestBookReview,
  getBookStilTotals,
  listLatestChapterReviews,
  listLektoratHotspotRows,
  listLektoratFindingRows,
  listChapterStilMetrics,
  listTopFiguresInChapter,
  listPageStilMetric,
  listPagesWithBody,
} = require('../../../db/book-chat/analysis');

// ── get_reviews ──────────────────────────────────────────────────────────────

const CHAPTER_REVIEW_FAZIT_CHARS = 400;
const CHAPTER_REVIEW_DEFAULT_LIMIT = 30;
const BOOK_REVIEW_FAZIT_CHARS = 600;

function _getBookReview(ctx) {
  const userEmail = ctx.userEmail || null;
  const row = getLatestBookReview(ctx.bookId, userEmail);
  if (!row) {
    return { scope: 'book', hint: 'Noch keine Buchbewertung vorhanden. Job „Buchbewertung" ausfuehren.' };
  }
  let parsed = null;
  try { parsed = row.review_json ? JSON.parse(row.review_json) : null; } catch { parsed = null; }
  if (!parsed) {
    return { scope: 'book', error: 'Buchbewertung kann nicht geparst werden.', errorKey: 'chat.toolError.reviewUnreadable', reviewed_at: row.reviewed_at };
  }
  const fazit = parsed.fazit || null;
  return _truncateResult({
    scope: 'book',
    book_name: row.book_name || null,
    reviewed_at: row.reviewed_at,
    ...(row.stale === 1 ? { stale: true, stale_hint: 'Buch wurde nach der Bewertung editiert — Review-Inhalt ggf. veraltet.' } : {}),
    gesamtnote: typeof parsed.gesamtnote === 'number' ? parsed.gesamtnote : null,
    zusammenfassung: parsed.zusammenfassung || null,
    fazit: fazit && fazit.length > BOOK_REVIEW_FAZIT_CHARS
      ? fazit.slice(0, BOOK_REVIEW_FAZIT_CHARS) + '…'
      : fazit,
    staerken: Array.isArray(parsed.staerken) ? parsed.staerken : [],
    schwaechen: Array.isArray(parsed.schwaechen) ? parsed.schwaechen : [],
    model: row.model || null,
  });
}

function tool_get_reviews(input, ctx) {
  const scope = input?.scope === 'book' ? 'book' : 'chapter';
  if (scope === 'book') return _getBookReview(ctx);
  const userEmail = ctx.userEmail || null;
  const chapterIdsFilter = Array.isArray(input?.chapter_ids)
    ? input.chapter_ids.filter(n => Number.isInteger(n))
    : null;
  const sort = input?.sort === 'note_asc' || input?.sort === 'note_desc' || input?.sort === 'chapter'
    ? input.sort
    : 'note_desc';
  const limit = Math.min(100, Math.max(1, Number.isInteger(input?.limit) ? input.limit : CHAPTER_REVIEW_DEFAULT_LIMIT));

  const rows = listLatestChapterReviews(ctx.bookId, userEmail, chapterIdsFilter);

  const items = [];
  for (const r of rows) {
    let parsed = null;
    try { parsed = r.review_json ? JSON.parse(r.review_json) : null; } catch { parsed = null; }
    if (!parsed) continue;
    const fazit = parsed.fazit || null;
    items.push({
      chapter_id:   r.chapter_id,
      chapter_position: r.chapter_position,
      chapter_name: r.chapter_name,
      reviewed_at:  r.reviewed_at,
      gesamtnote:   typeof parsed.gesamtnote === 'number' ? parsed.gesamtnote : null,
      zusammenfassung: parsed.zusammenfassung || null,
      fazit:        fazit && fazit.length > CHAPTER_REVIEW_FAZIT_CHARS
        ? fazit.slice(0, CHAPTER_REVIEW_FAZIT_CHARS) + '…'
        : fazit,
      staerken:     Array.isArray(parsed.staerken)   ? parsed.staerken   : [],
      schwaechen:   Array.isArray(parsed.schwaechen) ? parsed.schwaechen : [],
      model:        r.model || null,
      ...(r.stale === 1 ? { stale: true } : {}),
    });
  }

  if (sort === 'note_desc')      items.sort((a, b) => (b.gesamtnote ?? -1) - (a.gesamtnote ?? -1));
  else if (sort === 'note_asc')  items.sort((a, b) => (a.gesamtnote ?? 99) - (b.gesamtnote ?? 99));
  else                            items.sort((a, b) => (a.chapter_position ?? a.chapter_id) - (b.chapter_position ?? b.chapter_id));

  const total = items.length;
  const limited = items.slice(0, limit).map(({ chapter_position, ...rest }) => rest);
  const anyStale = limited.some(i => i.stale);

  const allChapters = listChaptersForBook(ctx.bookId);
  const reviewedIds = new Set(items.map(i => i.chapter_id));
  const missingReview = allChapters
    .filter(c => !reviewedIds.has(c.chapter_id))
    .map(c => ({ chapter_id: c.chapter_id, chapter_name: c.chapter_name }));

  return _truncateResult({
    scope: 'chapter',
    reviews: limited,
    total,
    sort,
    ...(anyStale ? { stale_hint: 'Mit stale:true markierte Kapitel wurden nach der Bewertung editiert — Review-Inhalt ggf. veraltet.' } : {}),
    ...(limited.length < total ? { truncated: true, shown: limited.length } : {}),
    ...(missingReview.length ? {
      ohne_bewertung: missingReview,
      hint: 'Diese Kapitel wurden noch nicht bewertet (chapter_reviews fehlt).',
    } : {}),
  });
}

// ── get_lektorat_hotspots ─────────────────────────────────────────────────────

const HOTSPOTS_DEFAULT_LIMIT = 20;
const HOTSPOTS_FAZIT_CHARS = 200;

function tool_get_lektorat_hotspots(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
  const minErrors     = Number.isInteger(input?.min_errors) ? Math.max(0, input.min_errors) : 0;
  const limit = Math.min(100, Math.max(1, Number.isInteger(input?.limit) ? input.limit : HOTSPOTS_DEFAULT_LIMIT));

  const rows = listLektoratHotspotRows(ctx.bookId, userEmail, chapterFilter).filter(r => (r.error_count || 0) >= minErrors);
  if (!rows.length) {
    return {
      hotspots: [],
      hint: 'Keine Lektorat-Ergebnisse mit den gewaehlten Filtern.',
    };
  }

  const byChapter = new Map();
  for (const r of rows) {
    const key = r.chapter_id ?? 0;
    if (!byChapter.has(key)) byChapter.set(key, {
      chapter_id: r.chapter_id,
      chapter_name: r.chapter_name || '(ohne Kapitel)',
      pages: 0, total_errors: 0, max_errors: 0,
    });
    const ch = byChapter.get(key);
    ch.pages++;
    ch.total_errors += r.error_count || 0;
    if ((r.error_count || 0) > ch.max_errors) ch.max_errors = r.error_count;
  }
  const perChapter = [...byChapter.values()].map(c => ({
    chapter_id: c.chapter_id,
    chapter_name: c.chapter_name,
    pages_checked: c.pages,
    total_errors: c.total_errors,
    avg_errors: Math.round((c.total_errors / c.pages) * 10) / 10,
    max_errors: c.max_errors,
  })).sort((a, b) => b.total_errors - a.total_errors);

  const top = rows.slice(0, limit).map(r => ({
    page_id: r.page_id,
    page_name: r.page_name,
    chapter_id: r.chapter_id,
    chapter_name: r.chapter_name || null,
    error_count: r.error_count || 0,
    checked_at: r.checked_at,
    fazit: r.fazit && r.fazit.length > HOTSPOTS_FAZIT_CHARS
      ? r.fazit.slice(0, HOTSPOTS_FAZIT_CHARS) + '…'
      : (r.fazit || null),
  }));

  return _truncateResult({
    pages_checked: rows.length,
    total_errors: rows.reduce((s, r) => s + (r.error_count || 0), 0),
    per_chapter: perChapter,
    top_pages: top,
    ...(top.length < rows.length ? { truncated: true, shown: top.length } : {}),
  });
}

// ── get_lektorat_findings ────────────────────────────────────────────────────

const FINDINGS_DEFAULT_LIMIT = 30;
const FINDINGS_MAX_LIMIT     = 100;
const FINDINGS_FIELD_CAP     = 600;

function _clampField(s) {
  if (typeof s !== 'string') return null;
  if (s.length <= FINDINGS_FIELD_CAP) return s;
  return s.slice(0, FINDINGS_FIELD_CAP) + '…';
}

function tool_get_lektorat_findings(input, ctx) {
  const userEmail = ctx.userEmail || null;
  const pageId    = Number.isInteger(input?.page_id)    ? input.page_id    : null;
  const chapterId = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
  const typFilter = typeof input?.typ === 'string' ? input.typ.toLowerCase().trim() : null;
  const limit     = Math.min(FINDINGS_MAX_LIMIT, Math.max(1,
    Number.isInteger(input?.limit) ? input.limit : FINDINGS_DEFAULT_LIMIT));

  const rows = listLektoratFindingRows(ctx.bookId, userEmail, { pageId, chapterId });
  if (!rows.length) {
    return {
      findings: [],
      hint: 'Keine Lektorat-Ergebnisse fuer diesen Filter. Lektorat-Job ausfuehren oder Filter weiten.',
    };
  }

  const findings = [];
  let totalAvailable = 0;
  for (const r of rows) {
    let errs = [];
    try { errs = JSON.parse(r.errors_json || '[]'); } catch { errs = []; }
    if (!Array.isArray(errs)) continue;
    for (const e of errs) {
      if (typFilter && (e.typ || '').toLowerCase() !== typFilter) continue;
      totalAvailable++;
      if (findings.length >= limit) continue;
      findings.push({
        page_id:      r.page_id,
        page_name:    r.page_name,
        chapter_id:   r.chapter_id,
        chapter_name: r.chapter_name || null,
        checked_at:   r.checked_at,
        typ:          e.typ || null,
        original:     _clampField(e.original),
        korrektur:    _clampField(e.korrektur),
        erklaerung:   _clampField(e.erklaerung),
        ...(Number.isInteger(e.offset) ? { offset: e.offset } : {}),
        ...(Number.isInteger(e.length) ? { length: e.length } : {}),
      });
    }
  }

  const byTyp = {};
  for (const r of rows) {
    let errs = [];
    try { errs = JSON.parse(r.errors_json || '[]'); } catch { errs = []; }
    if (!Array.isArray(errs)) continue;
    for (const e of errs) {
      if (typFilter && (e.typ || '').toLowerCase() !== typFilter) continue;
      const key = (e.typ || 'unbekannt').toLowerCase();
      byTyp[key] = (byTyp[key] || 0) + 1;
    }
  }

  return _truncateResult({
    findings,
    total_findings:    totalAvailable,
    pages_with_checks: rows.length,
    by_typ:            byTyp,
    ...(totalAvailable > findings.length
      ? { truncated: true, shown: findings.length, hint: 'Weitere Findings via typ/page_id/chapter_id einschraenken.' }
      : {}),
  });
}

// ── get_stil_metrics ──────────────────────────────────────────────────────────

const STIL_DEFAULT_LIMIT = 10;

function tool_get_stil_metrics(input, ctx) {
  const scope = input?.scope === 'chapter' || input?.scope === 'page' ? input.scope : 'book';
  const metric = STIL_METRIC_COLS.includes(input?.metric) ? input.metric : 'passive_count';
  const order = input?.order === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(50, Math.max(1, Number.isInteger(input?.limit) ? input.limit : STIL_DEFAULT_LIMIT));

  if (scope === 'book') {
    const r = getBookStilTotals(ctx.bookId);
    if (!r || !r.pages) return { hint: 'Keine Stil-Metriken vorhanden. Sync ausfuehren.' };
    const dialog_ratio = r.chars ? Math.round((r.dialog_chars / r.chars) * 1000) / 10 : null;
    return _truncateResult({
      scope: 'book',
      pages: r.pages,
      words: r.words, chars: r.chars,
      sentences: r.sentences, dialog_chars: r.dialog_chars,
      dialog_ratio_percent: dialog_ratio,
      filler_count: r.filler_count, passive_count: r.passive_count, adverb_count: r.adverb_count,
      avg_sentence_len: r.avg_sentence_len ? Math.round(r.avg_sentence_len * 10) / 10 : null,
      sentence_len_p90: r.sentence_len_p90 ? Math.round(r.sentence_len_p90 * 10) / 10 : null,
      lix: r.lix != null ? Math.round(r.lix * 10) / 10 : null,
      flesch_de: r.flesch_de != null ? Math.round(r.flesch_de * 10) / 10 : null,
    });
  }

  if (scope === 'chapter') {
    const chapterFilter = Number.isInteger(input?.chapter_id) ? input.chapter_id : null;
    const includeFigures = !!input?.include_figures;
    const rows = listChapterStilMetrics(ctx.bookId, chapterFilter);
    if (!rows.length) return { hint: 'Keine Stil-Metriken vorhanden.' };

    return _truncateResult({
      scope: 'chapter',
      chapters: rows.map(r => {
        const out = {
          chapter_id: r.chapter_id,
          chapter_name: r.chapter_name || '(ohne Kapitel)',
          pages: r.pages, words: r.words, chars: r.chars,
          sentences: r.sentences, dialog_chars: r.dialog_chars,
          dialog_ratio_percent: r.chars ? Math.round((r.dialog_chars / r.chars) * 1000) / 10 : null,
          filler_count: r.filler_count, passive_count: r.passive_count, adverb_count: r.adverb_count,
          avg_sentence_len: r.avg_sentence_len ? Math.round(r.avg_sentence_len * 10) / 10 : null,
          sentence_len_p90: r.sentence_len_p90 ? Math.round(r.sentence_len_p90 * 10) / 10 : null,
          lix: r.lix != null ? Math.round(r.lix * 10) / 10 : null,
          flesch_de: r.flesch_de != null ? Math.round(r.flesch_de * 10) / 10 : null,
        };
        if (includeFigures) {
          const top = listTopFiguresInChapter(r.chapter_id, ctx.bookId, ctx.userEmail || null);
          out.top_figuren = top.map(f => ({ fig_id: f.fig_id, name: f.name, mentions: f.total }));
        }
        return out;
      }),
    });
  }

  const rows = listPageStilMetric(ctx.bookId, metric, order, limit);
  return _truncateResult({
    scope: 'page',
    metric,
    order: order.toLowerCase(),
    pages: rows.map(r => ({
      page_id: r.page_id,
      page_name: r.page_name,
      chapter_id: r.chapter_id,
      chapter_name: r.chapter_name || null,
      words: r.words,
      [metric]: r.metric_value != null && metric.startsWith('avg_') ? Math.round(r.metric_value * 10) / 10 : r.metric_value,
    })),
  });
}

// ── find_repetitions ──────────────────────────────────────────────────────────

const REPETITIONS_DEFAULT_LIMIT = 30;
const REPETITIONS_MAX_LIMIT     = 100;
const REPETITIONS_SAMPLE_PAGES  = 5;
const REPETITION_STOPWORDS = new Set([
  'der','die','das','den','dem','des','ein','eine','einen','einem','einer','eines',
  'und','oder','aber','doch','denn','sondern','als','wie','wenn','dass','daß','weil',
  'in','im','an','am','auf','auch','aus','bei','beim','mit','nach','von','vom','vor',
  'zu','zum','zur','über','unter','durch','für','um','ohne','gegen','seit','bis',
  'ist','war','sind','waren','sein','seine','seinen','seinem','seiner','wird','werden',
  'wurde','wurden','hat','hatte','haben','hatten','kann','konnte','soll','sollte',
  'mag','mochte','muss','musste','will','wollte','er','sie','es','wir','ihr','sich',
  'mir','dir','ihm','ihn','ihnen','mich','dich','uns','euch','mein','dein','sein',
  'unser','euer','nicht','nur','noch','schon','immer','dann','so','sehr',
  'mehr','wieder','etwas','nichts','jetzt','dort','hier','heute','gestern','morgen',
  'the','a','an','and','or','but','as','if','when','that','because','of','in','on',
  'at','by','for','to','with','from','up','about','into','over','after','it','he',
  'she','they','we','his','her','their','our','my','your','is','are','was','were',
  'be','been','being','have','has','had','do','does','did','can','could','will',
  'would','should','may','might','must','not','no','yes','so','very','more','only',
]);

const _TOKEN_RE = /[a-zäöüß][a-zäöüß'-]*/gi;

function _tokenizeForRepetitions(text) {
  const tokens = [];
  for (const m of text.toLowerCase().matchAll(_TOKEN_RE)) {
    if (m[0].length >= 2) tokens.push(m[0]);
  }
  return tokens;
}

function _ngramFreq(tokens, n, ignoreStopwords) {
  const freq = new Map();
  if (tokens.length < n) return freq;
  for (let i = 0; i <= tokens.length - n; i++) {
    let allStop = true;
    for (let k = 0; k < n; k++) {
      if (!REPETITION_STOPWORDS.has(tokens[i + k])) { allStop = false; break; }
    }
    if (ignoreStopwords && allStop) continue;
    const phrase = tokens.slice(i, i + n).join(' ');
    freq.set(phrase, (freq.get(phrase) || 0) + 1);
  }
  return freq;
}

function tool_find_repetitions(input, ctx) {
  const n = [2, 3, 4, 5].includes(input?.n) ? input.n : 3;
  const scope = ['book', 'chapter', 'page'].includes(input?.scope) ? input.scope : 'book';
  const ignoreStopwords = input?.ignore_stopwords !== false;
  const minCount = Math.max(2, Number.isInteger(input?.min_count) ? input.min_count : (scope === 'book' ? 5 : 2));
  const limit = Math.min(REPETITIONS_MAX_LIMIT, Math.max(1, Number.isInteger(input?.limit) ? input.limit : REPETITIONS_DEFAULT_LIMIT));

  const filter = {};
  if (scope === 'chapter') {
    if (!Number.isInteger(input?.chapter_id)) return { error: 'chapter_id fehlt (scope=chapter)', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'chapter_id' } };
    filter.chapterId = input.chapter_id;
  } else if (scope === 'page') {
    if (!Number.isInteger(input?.page_id)) return { error: 'page_id fehlt (scope=page)', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'page_id' } };
    filter.pageId = input.page_id;
  }
  const pages = listPagesWithBody(ctx.bookId, filter);
  if (!pages.length) {
    return { results: [], hint: 'Keine Abschnitte mit body_html im gewaehlten Scope. Sync ausfuehren.' };
  }

  const totalFreq = new Map();
  const perPage = new Map();
  const pageInfo = new Map();
  for (const p of pages) {
    pageInfo.set(p.page_id, { page_name: p.page_name, chapter_id: p.chapter_id });
    const text = htmlToPlainText(p.body_html);
    const tokens = _tokenizeForRepetitions(text);
    const freq = _ngramFreq(tokens, n, ignoreStopwords);
    for (const [phrase, count] of freq) {
      totalFreq.set(phrase, (totalFreq.get(phrase) || 0) + count);
      if (!perPage.has(phrase)) perPage.set(phrase, new Map());
      perPage.get(phrase).set(p.page_id, count);
    }
  }

  const filtered = [...totalFreq.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const total = filtered.length;
  const top = filtered.slice(0, limit).map(([phrase, count]) => {
    const samples = [...(perPage.get(phrase) || new Map()).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, REPETITIONS_SAMPLE_PAGES)
      .map(([pageId, c]) => {
        const info = pageInfo.get(pageId);
        return { page_id: pageId, page_name: info?.page_name || null, count: c };
      });
    return { phrase, count, sample_pages: samples };
  });

  return _truncateResult({
    n,
    scope,
    min_count: minCount,
    pages_scanned: pages.length,
    total_results: total,
    results: top,
    ...(total > top.length ? { truncated: true } : {}),
  });
}

module.exports = {
  tool_get_reviews,
  tool_get_lektorat_hotspots,
  tool_get_lektorat_findings,
  tool_get_stil_metrics,
  tool_find_repetitions,
};
