'use strict';
// Scope-Dispatcher fuer Export-Pipelines (Buch/Kapitel/Seite). Liefert eine
// einheitliche `groups`-Liste, gegen die alle Format-Builder + die PDF-Render-
// Pipeline arbeiten. Loest die bisherige `lib/load-book-contents.js` ab.
//
// Output-Shape:
//   {
//     scope: 'book' | 'chapter' | 'page',
//     book,                            // mapBook-Domain-Shape
//     chapter?: <mapChapter>,          // bei scope='chapter' / 'page' (falls Page in Kapitel)
//     page?:    <mapPage>,             // bei scope='page'
//     groups:   [{ chapterId, chapter, pages: [{ p: <pageMeta>, pd: <pageFull> }] }]
//   }
//
// Eine Gruppe mit `pages: []` ist eine reine Kapitel-Ueberschrift (Kapitel ohne
// eigenen Abschnitt, dessen Unterkapitel Text tragen, siehe _groupByChapter).
// Jeder Builder rendert dafuer die Ueberschrift und sonst nichts.
//
// Konsumenten: routes/export.js (Sync-Route) und routes/jobs/pdf-export.js
// (Custom-PDF). Storage-Zugriff laeuft ueber lib/content-store.js.

const contentStore = require('./content-store');
const { attachHeadlines } = require('./headline-render');

function _empty(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

// Kapitel mit `excluded`-Flag (und alle ihre Nachfahren) werden aus den Exporten
// herausgefiltert. Der Ausschluss kaskadiert: ist ein Elternkapitel excluded,
// fliegen auch dessen Unterkapitel raus. Fassungen/Snapshots umgehen diesen
// Loader (contentStore.bookTree) und behalten ausgeschlossene Kapitel.
function _excludedChapterIds(sortedChapters) {
  const byId = new Map(sortedChapters.map(c => [c.id, c]));
  const isExcluded = (c) => {
    let cur = c;
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      if (cur.excluded) return true;
      seen.add(cur.id);
      cur = cur.parent_chapter_id != null ? byId.get(cur.parent_chapter_id) : null;
    }
    return false;
  };
  const set = new Set();
  for (const c of sortedChapters) if (isExcluded(c)) set.add(c.id);
  return set;
}

async function _loadBookGroups(bookId, ctx) {
  const [sortedChapters, allPages] = await Promise.all([
    contentStore.listChapters(bookId, ctx),
    contentStore.listPages(bookId, ctx),
  ]);
  if (!allPages.length) throw _empty('BOOK_EMPTY');

  const excludedIds = _excludedChapterIds(sortedChapters);
  const chapterOrder = Object.fromEntries(sortedChapters.map((c, i) => [c.id, i]));
  const orderedPages = [...allPages]
    .filter(p => !(p.chapter_id && excludedIds.has(p.chapter_id)))
    .sort((a, b) => {
    const aO = a.chapter_id ? (chapterOrder[a.chapter_id] ?? 999) : -1;
    const bO = b.chapter_id ? (chapterOrder[b.chapter_id] ?? 999) : -1;
    if (aO !== bO) return aO - bO;
    return (a.position ?? 0) - (b.position ?? 0);
  });

  const pageDetails = await contentStore.loadPagesBatch(orderedPages, ctx, {
    onError: () => null,
  });
  const detailById = new Map(pageDetails.map(d => d ? [d.id, d] : [null, null]));
  const valid = orderedPages
    .map(p => ({ p, pd: detailById.get(p.id) || null }))
    .filter(x => x.pd && x.pd.html);
  if (!valid.length) throw _empty('BOOK_EMPTY');

  return _groupByChapter(valid, sortedChapters);
}

// Kapitel-IDs eines Kapitel-Exports/-Shares: das Kapitel selbst und — bei
// `includeSubchapters` — sein ganzer Teilbaum aus der `parent_chapter_id`-Kette.
// Ausgeschlossene Unterkapitel (samt ihren Nachfahren) fallen raus, das
// gewaehlte Kapitel selbst bleibt (der User hat es bewusst gewaehlt).
// SSoT fuer Kapitel-Export, Kapitel-Share (Render, Bild-Scope, Block-ID-
// Backfill, Link-Zaehler).
function chapterScopeIds(chapterId, sortedChapters, { includeSubchapters = true } = {}) {
  const ids = new Set([chapterId]);
  if (!includeSubchapters) return ids;
  // Ausschluss kaskadiert nur innerhalb des Teilbaums: ein ausgeschlossenes
  // Unterkapitel nimmt seine Nachfahren mit, ein Ausschluss der Wurzel oder
  // eines Vorfahren darueber nicht (die Wurzel ist bewusst gewaehlt).
  const excluded = new Set(sortedChapters.filter(c => c.excluded).map(c => c.id));
  const kids = new Map();
  for (const c of sortedChapters) {
    if (c.parent_chapter_id == null) continue;
    if (!kids.has(c.parent_chapter_id)) kids.set(c.parent_chapter_id, []);
    kids.get(c.parent_chapter_id).push(c.id);
  }
  const stack = [...(kids.get(chapterId) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (ids.has(id) || excluded.has(id)) continue;
    ids.add(id);
    stack.push(...(kids.get(id) || []));
  }
  return ids;
}

// Gruppiert die (lesegeordneten) Seiten zu Kapitel-Gruppen. Ein Kapitel ist
// sein ganzer Teilbaum: beginnt eine Gruppe, deren Vorfahren noch keine eigene
// Gruppe haben (Kapitel ohne eigenen Abschnitt, z. B. «Teil I» nur mit
// Unterkapiteln), entsteht davor fuer jeden solchen Vorfahren eine reine
// Ueberschriften-Gruppe `{ chapterId, chapter, pages: [] }`. Damit traegt jede
// Ausgabe die Ueberschrift, und die Tiefe, die die Builder aus den Kapiteln in
// `groups` ableiten, folgt der vollen Elternkette. Vorfahren ausserhalb von
// `scopeIds` (Kapitel-Export: alles oberhalb des gewaehlten Kapitels) bleiben
// weg — die exportierte Einheit beginnt bei Ebene 1.
function _groupByChapter(valid, sortedChapters, scopeIds = null) {
  const byId = new Map(sortedChapters.map(c => [c.id, c]));
  const emitted = new Set();
  const groups = [];
  let cur = null;
  for (const x of valid) {
    if (x.p.chapter_id) {
      if (!cur || cur.chapterId !== x.p.chapter_id) {
        const chapter = byId.get(x.p.chapter_id) || null;
        const chain = [];
        const seen = new Set([x.p.chapter_id]);
        let anc = chapter?.parent_chapter_id != null ? byId.get(chapter.parent_chapter_id) : null;
        while (anc && !seen.has(anc.id) && !emitted.has(anc.id)
               && (!scopeIds || scopeIds.has(anc.id))) {
          seen.add(anc.id);
          chain.unshift(anc);
          anc = anc.parent_chapter_id != null ? byId.get(anc.parent_chapter_id) : null;
        }
        for (const a of chain) {
          groups.push({ chapterId: a.id, chapter: a, pages: [] });
          emitted.add(a.id);
        }
        cur = { chapterId: x.p.chapter_id, chapter, pages: [] };
        groups.push(cur);
        emitted.add(x.p.chapter_id);
      }
      cur.pages.push(x);
    } else {
      groups.push({ chapterId: null, chapter: null, pages: [x] });
      cur = null;
    }
  }
  return groups;
}

async function _loadChapterGroups(chapterId, ctx, { includeSubchapters = true } = {}) {
  const chapter = await contentStore.loadChapter(chapterId, ctx);
  if (!chapter) throw _empty('CHAPTER_NOT_FOUND');
  const [sortedChapters, bookPages] = await Promise.all([
    contentStore.listChapters(chapter.book_id, ctx),
    contentStore.listPages(chapter.book_id, ctx),
  ]);

  // chapters.position ist depth-first global lueckenlos (siehe
  // docs/chapter-hierarchy.md), also reicht position-sort fuer Tree-Reihenfolge.
  const chapterIdSet = chapterScopeIds(chapter.id, sortedChapters, { includeSubchapters });

  const chapterOrder = Object.fromEntries(sortedChapters.map((c, i) => [c.id, i]));
  const chapterPages = bookPages
    .filter(p => chapterIdSet.has(p.chapter_id))
    .sort((a, b) => {
      const aO = chapterOrder[a.chapter_id] ?? 999;
      const bO = chapterOrder[b.chapter_id] ?? 999;
      if (aO !== bO) return aO - bO;
      return (a.position ?? 0) - (b.position ?? 0);
    });
  if (!chapterPages.length) throw _empty('CHAPTER_EMPTY');

  const pageDetails = await contentStore.loadPagesBatch(chapterPages, ctx, {
    onError: () => null,
  });
  const detailById = new Map(pageDetails.map(d => d ? [d.id, d] : [null, null]));
  const valid = chapterPages
    .map(p => ({ p, pd: detailById.get(p.id) || null }))
    .filter(x => x.pd && x.pd.html);
  if (!valid.length) throw _empty('CHAPTER_EMPTY');

  return {
    chapter,
    groups: _groupByChapter(valid, sortedChapters, chapterIdSet),
  };
}

async function _loadPageGroup(pageId, ctx) {
  const page = await contentStore.loadPage(pageId, ctx);
  if (!page || !page.html) throw _empty('PAGE_EMPTY');
  let chapter = null;
  if (page.chapter_id) {
    try { chapter = await contentStore.loadChapter(page.chapter_id, ctx); }
    catch { chapter = null; }
  }
  return {
    page,
    chapter,
    groups: [{
      chapterId: chapter?.id ?? null,
      chapter,
      pages: [{ p: page, pd: page }],
    }],
  };
}

/**
 * Dispatcher.
 *
 * @param {{ scope: 'book'|'chapter'|'page', id: number, includeSubchapters?: boolean }} ref
 *   `includeSubchapters` (nur scope='chapter', Default true): ein Kapitel ist
 *   sein ganzer Teilbaum. `false` nur, wo ein Aufrufer bewusst nur die direkten
 *   Abschnitte will (Export-Dialog-Schalter).
 * @param {*} ctx  Express-Request oder Token-Objekt (siehe content-store).
 * @returns {Promise<{ scope, book, chapter?, page?, groups }>}
 */
async function loadContents({ scope, id, includeSubchapters = true }, ctx) {
  if (!Number.isFinite(id) || id <= 0) {
    const err = new Error('BAD_ID');
    err.code = 'BAD_ID';
    throw err;
  }
  // `attachHeadlines` haengt den Titel-Kopf (Dachzeile/Titel/Lead) an die
  // Seiten-Metadaten — hier und nur hier, damit ihn jeder Export-Weg und der
  // Buch-/Kapitel-Share ohne eigenen Nachladepfad traegt (lib/headline-render.js).
  // No-op ausserhalb journalistischer Buecher.
  if (scope === 'book') {
    const [book, groups] = await Promise.all([
      contentStore.loadBook(id, ctx),
      _loadBookGroups(id, ctx),
    ]);
    return attachHeadlines({ scope: 'book', book, groups });
  }
  if (scope === 'chapter') {
    const { chapter, groups } = await _loadChapterGroups(id, ctx, { includeSubchapters });
    const book = await contentStore.loadBook(chapter.book_id, ctx);
    return attachHeadlines({ scope: 'chapter', book, chapter, groups });
  }
  if (scope === 'page') {
    const { page, chapter, groups } = await _loadPageGroup(id, ctx);
    const book = await contentStore.loadBook(page.book_id, ctx);
    return attachHeadlines({ scope: 'page', book, chapter, page, groups });
  }
  const err = new Error('BAD_SCOPE');
  err.code = 'BAD_SCOPE';
  throw err;
}

module.exports = { loadContents, chapterScopeIds, _groupByChapter };
