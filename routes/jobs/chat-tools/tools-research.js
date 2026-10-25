'use strict';
// Recherche-Werkzeuge der Chats: Archiv auflisten und lesen, semantische
// Passagen-Suche im Archiv, bibliografische Register (Crossref/OpenLibrary) und
// die kompakte Welt-Übersicht. Rückwärtsgewandt und rein lesend — Vorschläge
// (propose_research_item) bleiben beim Recherche-Chat (../research-chat-tools.js).
// SQL in db/book-chat/research.js.

const searchIndex = require('../../../lib/search');
const embed = require('../../../lib/embed');
const semanticRetrieval = require('../../../lib/semantic-retrieval');
const sourceLookup = require('../../../lib/source-lookup');
const { LIST_FILTER_KINDS, RESEARCH_STATUS_SET } = require('../../../lib/research-validate');
const { attachRelations, itemIdsAtPlace } = require('../../../db/research-items');
const {
  listResearchItemsFiltered, researchTagsByItem, researchUrlsByItem, getResearchItemForRead,
  getResearchItemTitleInBook, researchItemMeta, listBookEntityRows,
} = require('../../../db/book-chat/research');
const { toolHint } = require('./shared');

// FTS-Vorfilter weit fassen (wie das Board), dann auf ITEM_LIST_MAX kappen.
const FTS_LIMIT = 500;
const ITEM_LIST_MAX = 60;
const SNIPPET_MAX = 220;
const DOC_TEXT_MAX = 8000;

const _snip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Verknuepfungen eines Fundstuecks, kompakt fuers Modell: `stellen` = Kapitel/
// Seiten (wo es im Buch steht bzw. eingearbeitet ist), `bezug` = Figuren, Orte,
// Szenen, Beats, Straenge. Labels kommen aus db/research-items#attachRelations.
// Figuren/Orte mit ihrer oeffentlichen Kennung (`ref_id` = fig_id/loc_id), wie in
// list_book_entities und den anderen Werkzeugen.
function _linkView(links) {
  const stellen = [];
  const bezug = [];
  for (const l of (links || [])) {
    const e = { art: l.target_kind, id: l.ref_id ?? l.target_id, name: l.label || '' };
    (l.target_kind === 'chapter' || l.target_kind === 'page' ? stellen : bezug).push(e);
  }
  return { stellen, bezug };
}

// ── list_research_items ──────────────────────────────────────────────────────
function tool_list_research_items(input, ctx) {
  // Kapitel-Filter umfasst direkt am Kapitel verknuepfte Fundstuecke UND solche an
  // Seiten des Kapitels (gleiche Regel wie list_ideen). Mehrere Vorauswahlen
  // (Stelle, Volltext) schneiden sich.
  let ids = null;
  const chapterId = parseInt(input.chapter_id, 10);
  const pageId = parseInt(input.page_id, 10);
  if (pageId || chapterId) ids = itemIdsAtPlace(ctx.bookId, pageId ? { pageId } : { chapterId });

  const q = String(input.q || '').trim();
  if (q && (!ids || ids.length)) {
    try {
      const hits = searchIndex.query(q, { bookId: ctx.bookId, kinds: ['research'], limit: FTS_LIMIT });
      const ftsIds = (hits?.hits || []).map(h => h.entity_id).filter(Boolean);
      ids = ids ? ids.filter(id => ftsIds.includes(id)) : ftsIds;
    } catch (e) {
      ctx.logger?.warn?.(`[research] FTS-Filter fehlgeschlagen: ${e.message}`);
    }
  }

  // Gesamtzahl passender Einträge — damit das Modell weiss, ob die auf ITEM_LIST_MAX
  // gedeckelte Liste gekürzt ist (statt still „nur diese existieren" anzunehmen).
  const { total, rows } = listResearchItemsFiltered(ctx.bookId, {
    kind: LIST_FILTER_KINDS.has(input.kind) ? input.kind : null,
    status: RESEARCH_STATUS_SET.has(input.status) ? input.status : null,
    ids,
    limit: ITEM_LIST_MAX,
  });
  const rowIds = rows.map(r => r.id);
  const tagsBy = researchTagsByItem(rowIds);
  const urlsBy = researchUrlsByItem(rowIds);
  const linksBy = new Map(attachRelations(rowIds.map(id => ({ id }))).map(r => [r.id, r.links]));

  const items = rows.map(r => {
    const urls = urlsBy.get(r.id) || [];
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      title: r.title || '',
      snippet: _snip(r.body || urls[0] || r.source, SNIPPET_MAX),
      tags: tagsBy.get(r.id) || [],
      ..._linkView(linksBy.get(r.id)),
      url_count: urls.length,
      has_doc: !!r.has_doc,
      ...(r.doc_name ? { doc_name: r.doc_name } : {}),
    };
  });
  return { items, count: items.length, total, truncated: total > items.length };
}

// ── read_research_item ───────────────────────────────────────────────────────
function tool_read_research_item(input, ctx) {
  const id = parseInt(input.id, 10);
  if (!id) return { error: 'id fehlt oder ungültig.', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'id' } };
  const row = getResearchItemForRead(id, ctx.bookId);
  if (!row) return { error: 'Eintrag nicht gefunden.', errorKey: 'chat.toolError.notFound' };
  // Ein langes PDF passt nicht in ein Tool-Result. Die Kappung wird deshalb
  // AUSGEWIESEN (doc_chars + doc_truncated) statt still zu passieren — sonst hält
  // das Modell den Anfang für das ganze Dokument.
  const docText = String(row.doc_text || '');
  const docTruncated = docText.length > DOC_TEXT_MAX;
  const [withLinks] = attachRelations([{ id: row.id }]);
  const moreHint = toolHint(ctx, 'search_research_passages',
    ` Für Stellen weiter hinten: search_research_passages mit item_id=${row.id} und deiner Frage.`)
    || ' Der Rest des Dokuments ist in diesem Chat nicht erreichbar; für Stellen weiter hinten den Recherche-Chat empfehlen.';
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    ..._linkView(withLinks.links),
    title: row.title || '',
    body: row.body || '',
    urls: row.urls,
    source: row.source || '',
    tags: row.tags,
    ...(row.doc_name ? { doc_name: row.doc_name } : {}),
    ...(docText ? {
      doc_text: docText.slice(0, DOC_TEXT_MAX),
      doc_chars: docText.length,
      doc_truncated: docTruncated,
      ...(docTruncated ? { hinweis: `Nur die ersten ${DOC_TEXT_MAX} von ${docText.length} Zeichen.${moreHint}` } : {}),
    } : {}),
  };
}

// ── search_research_passages ─────────────────────────────────────────────────
// Semantischer Zugriff aufs Archiv. Zwei Modi, ein Werkzeug:
//   ohne item_id → beste Passage je Eintrag, über das ganze Archiv (semanticQuery,
//                  kinds:['research'] → Hybrid-Fusion mit FTS + optional Rerank)
//   mit item_id  → mehrere Passagen INNERHALB eines Eintrags (passagesInEntity).
// Der zweite Modus ist der Grund für das Werkzeug: `read_research_item` liefert
// von einem langen PDF nur den Anfang, hier kommen die zur Frage passenden
// Stellen aus der Mitte. Setzt den Embedding-Index voraus (routes/jobs/embed-index).
const PASSAGE_MAX = 1200;
const PASSAGE_TOPK_DEFAULT = 6;
const PASSAGE_TOPK_MAX = 15;

function _wordSearchHint(ctx) {
  return toolHint(ctx, 'list_research_items', ' Nutze list_research_items (Wortsuche).');
}

async function tool_search_research_passages(input, ctx) {
  const q = String(input.q || '').trim();
  if (!q) return { error: 'q fehlt.', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'q' } };
  if (!embed.isEnabled()) {
    return { error: `Semantische Suche ist nicht aktiviert.${_wordSearchHint(ctx)}`, errorKey: 'chat.toolError.semanticUnavailable' };
  }
  const topK = Math.min(Math.max(parseInt(input.top_k, 10) || PASSAGE_TOPK_DEFAULT, 1), PASSAGE_TOPK_MAX);
  const itemId = input.item_id ? parseInt(input.item_id, 10) : null;

  try {
    if (itemId) {
      // Buch-Guard: nur Einträge DIESES Buchs; sonst liesse sich über eine geratene
      // id fremdes Material lesen (der Index selbst ist buchübergreifend).
      const row = getResearchItemTitleInBook(itemId, ctx.bookId);
      if (!row) return { error: 'Eintrag nicht gefunden.', errorKey: 'chat.toolError.notFound' };
      const passages = await semanticRetrieval.passagesInEntity('research', itemId, q, { topK, signal: ctx.jobSignal });
      return {
        item_id: itemId, title: row.title || '', q,
        passages: passages.map(p => ({ passage: _snip(p.text, PASSAGE_MAX), score: Math.round(p.score * 1000) / 1000 })),
        count: passages.length,
        ...(passages.length ? {} : { hinweis: 'Keine Passage im Index — ist der Eintrag schon indexiert?' }),
      };
    }

    const hits = await semanticRetrieval.semanticQuery(ctx.bookId, q, { kinds: ['research'], topK, signal: ctx.jobSignal });
    if (!hits.length) return { q, results: [], count: 0 };
    const meta = researchItemMeta(ctx.bookId, hits.map(h => h.entity_id));
    const results = hits
      .filter(h => meta.has(h.entity_id))   // Fremdbuch-/Geister-Chunk überspringen
      .map(h => {
        const m = meta.get(h.entity_id);
        return {
          item_id: h.entity_id, kind: m.kind, title: m.title || '',
          ...(m.doc_name ? { doc_name: m.doc_name } : {}),
          passage: _snip(h.text, PASSAGE_MAX),
          score: Math.round(h.score * 1000) / 1000,
        };
      });
    return { q, results, count: results.length };
  } catch (e) {
    // Abbruch des Jobs ist kein Werkzeug-Fehler: weiterwerfen, sonst rechnet der
    // Loop mit einem {error} weiter, obwohl der User gestoppt hat.
    if (e?.name === 'AbortError') throw e;
    ctx.logger?.warn?.(`[research] Passagen-Suche fehlgeschlagen: ${e.message}`);
    return { error: `Semantische Suche nicht verfügbar (${e.message}).${_wordSearchHint(ctx)}`, errorKey: 'chat.toolError.semanticUnavailable' };
  }
}

// ── list_book_entities ───────────────────────────────────────────────────────
const ENTITY_ARTEN = ['figur', 'ort', 'szene', 'beat', 'strang'];
const ENTITY_LIMIT = 120;

/** Kompakte Einträge einer Welt-Kategorie (auch für den Prompt des Recherche-Chats). */
function entityList(art, ctx) {
  return listBookEntityRows(art, ctx.bookId, ctx.userEmail).slice(0, ENTITY_LIMIT).map(r => {
    const meta = [_snip(r.typ, 40), _snip(r.rolle || r.land, 40), _snip(r.beschreibung || r.kommentar, 140)]
      .filter(Boolean).join(' · ');
    return { id: r.id, name: r.label, ...(meta ? { kontext: meta } : {}) };
  });
}

function tool_list_book_entities(input, ctx) {
  const art = ENTITY_ARTEN.includes(input.art) ? input.art : 'alle';
  if (art !== 'alle') return { art, entities: entityList(art, ctx) };
  return {
    figuren:           entityList('figur', ctx),
    schauplaetze:      entityList('ort', ctx),
    szenen:            entityList('szene', ctx),
    plot_abschnitte:   entityList('beat', ctx),
    handlungsstraenge: entityList('strang', ctx),
  };
}

// ── lookup_literature ────────────────────────────────────────────────────────
// Bibliografische Register statt Web-Trefferseiten: Crossref (Aufsaetze, alles
// mit DOI) und OpenLibrary (Buecher), feste Hosts in lib/source-lookup.js — kein
// SSRF-Pfad, der User-Input landet nur URL-encodiert in Query/Pfad. Liefert
// zitierfaehige Kerndaten (Autoren, Jahr, DOI/ISBN). Die Treffer-URLs merkt sich
// ctx.literatureHits: sie sind in diesem Lauf gesehen und darum als Beleg in
// final_answer.quellen zulaessig (validateAnswerSources, `extra`).
const LITERATURE_ROWS_DEFAULT = 5;

function _persons(list) {
  return (list || []).slice(0, 6).map(a => (typeof a === 'string' ? a : [a?.given, a?.family].filter(Boolean).join(' ') || a?.literal || ''))
    .filter(Boolean).join(', ');
}

function _literatureView(draft, register) {
  const url = draft.doi ? `https://doi.org/${draft.doi}`
    : (draft.url || (draft.isbn ? `https://openlibrary.org/isbn/${encodeURIComponent(draft.isbn)}` : null));
  return {
    titel: draft.title || '',
    autoren: _persons(draft.authors) || _persons(draft.editors),
    jahr: draft.year || null,
    typ: draft.csl_type,
    ...(draft.container_title ? { in: draft.container_title } : {}),
    ...(draft.publisher ? { verlag: draft.publisher } : {}),
    ...(draft.doi ? { doi: draft.doi } : {}),
    ...(draft.isbn ? { isbn: draft.isbn } : {}),
    ...(url ? { url } : {}),
    register,
  };
}

function _rememberLiterature(ctx, views) {
  if (!ctx) return;
  if (!Array.isArray(ctx.literatureHits)) ctx.literatureHits = [];
  for (const v of views) if (v.url) ctx.literatureHits.push({ url: v.url, title: v.titel || v.url });
}

async function tool_lookup_literature(input, ctx) {
  try {
    if (input.doi || input.isbn) {
      const draft = input.doi ? await sourceLookup.lookupDoi(input.doi) : await sourceLookup.lookupIsbn(input.isbn);
      if (!draft) return { treffer: [], hinweis: 'Unter dieser Kennung kein Eintrag im Register.' };
      const view = _literatureView(draft, input.doi ? 'crossref' : 'openlibrary');
      _rememberLiterature(ctx, [view]);
      return { treffer: [view] };
    }
    const q = String(input.q || '').trim();
    if (!q) return { error: 'q, doi oder isbn angeben.', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'q/doi/isbn' } };
    const register = ['artikel', 'buch', 'beide'].includes(input.register) ? input.register : 'beide';
    const { hits, failed } = await sourceLookup.searchLiterature(q, { register, rows: input.anzahl || LITERATURE_ROWS_DEFAULT });
    const views = hits.map(h => _literatureView(h.draft, h.register));
    _rememberLiterature(ctx, views);
    return {
      q, treffer: views, count: views.length,
      // Ein ausgefallenes Register ist kein „dazu gibt es nichts".
      ...(failed.length ? { register_ausgefallen: failed, hinweis: 'Ein Register war nicht erreichbar — fehlende Treffer dort sind keine Fehlanzeige.' } : {}),
    };
  } catch (e) {
    ctx?.logger?.warn?.(`[research] Literatur-Suche fehlgeschlagen: ${e.message}`);
    return { error: `Literatur-Register nicht erreichbar.${toolHint(ctx, 'web_search', ' Nutze web_search.')}`, errorKey: 'chat.toolError.serviceUnavailable' };
  }
}

module.exports = {
  tool_list_research_items,
  tool_read_research_item,
  tool_search_research_passages,
  tool_lookup_literature,
  tool_list_book_entities,
  entityList,
};
