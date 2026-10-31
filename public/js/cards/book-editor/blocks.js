// Teil von bookEditorCard (Facade cards/book-editor-card.js): Aufbau der
// Blockliste — aus der Server-Aggregation (`/book-editor/:id/contents`) oder,
// ohne Netz, aus dem Content-Cache (offline gehaltenes Buch).

import { fromPages } from '../../manuscript-stream.js';
import { sectionTitleRedundant, sectionCountsByChapter } from '../../structure-title.js';
import { stripFocusArtefacts, isNetworkError } from '../../utils.js';
import { contentRepo } from '../../repo/content.js';

// Build-Funktion getrennt für Unit-Tests.
// Baut die Render-Blockliste über das geteilte Stream-Modell (fromPages) und
// wrappt jeden Page-Entry mit dem Editor-State (dirty/saving/_rev/originalHtml).
// stripFocusArtefacts bleibt hier (browser-only) statt im pure Modell.
// originalUpdatedAt kommt aus der Quell-Page (das Modell trägt kein updated_at).
// `chapters` = Top-Level-Feld `chapters` der Antwort ([{ id, name, parentId }]):
// Elternkette für Header von Kapiteln ohne eigenen Abschnitt + echte Tiefe.
export function buildBlocksFromPages(pages, chapters = null) {
  const byId = new Map();
  for (const p of (pages || [])) byId.set(p.pageId, p);
  // `dupTitle`: einziger Abschnitt seines Kapitels oder erster, der wie das
  // Kapitel heisst — der Kopf zeigt dann keinen zweiten Namen (Regel wie
  // Share-Reader/PDF, structure-title.js#sectionTitleRedundant).
  let pendingChapter = null;
  const entries = fromPages(pages, { chapters });
  const counts = sectionCountsByChapter(entries);
  return entries.map((e) => {
    if (e.kind === 'chapter') { pendingChapter = e; return { kind: 'chapter', chapterId: e.chapterId, name: e.name, depth: e.depth }; }
    const src = byId.get(e.id) || {};
    const html = stripFocusArtefacts(e.html || '');
    const dupTitle = !!pendingChapter && pendingChapter.chapterId === e.chapterId && sectionTitleRedundant({
      index: 0, count: counts.get(e.chapterId) || 0, pageName: e.name, chapterName: pendingChapter.name,
    });
    pendingChapter = null;
    return {
      kind: 'page',
      pageId: e.id,
      name: e.name,
      dupTitle,
      chapterId: e.chapterId,
      html,
      originalHtml: html,
      originalUpdatedAt: src.updated_at || null,
      dirty: false,
      saving: false,
      saveError: '',
      conflict: null,
      savedAt: null,
      // Letzter Save scheiterte am Netz; der Stand liegt als Entwurf (drafts.js).
      offline: false,
      draftFailed: false,   // Entwurf liess sich lokal nicht sichern (Speicher voll)
      // Save-Kennungen, die ein wiederhergestellter Entwurf von seinem
      // Schreiber mitbringt (drafts.js#_restoreBlockDrafts) — der eigene Save
      // mit verlorener Antwort bleibt so auch nach einem Neustart „eigen".
      _draftOwn: null,
      _rev: 0,
    };
  });
}

// Lesereihenfolge wie der Server (routes/book-editor.js): Abschnitte ohne
// Kapitel zuerst, dann die Kapitel depth-first samt Unterkapiteln
// (lib/content-store#flattenTree). Pure, Eingabe ist der `/content/books/:id/tree`.
export function pageMetasFromTree(tree) {
  const inChapters = [];
  (function walk(chapters) {
    for (const c of (chapters || [])) {
      for (const p of (c.pages || [])) inChapters.push({ id: p.id, chapterId: c.id, chapterName: c.name });
      walk(c.subchapters);
    }
  })(tree?.chapters);
  const solos = (tree?.topPages || []).map((p) => ({ id: p.id, chapterId: null, chapterName: null }));
  return [...solos, ...inChapters];
}

// Kapitel-Liste wie das `chapters`-Feld der Server-Antwort ([{ id, name, parentId }]).
export function chaptersFromTree(tree) {
  const out = [];
  (function walk(chapters, parentId) {
    for (const c of (chapters || [])) {
      out.push({ id: c.id, name: c.name, parentId });
      walk(c.subchapters, c.id);
    }
  })(tree?.chapters, null);
  return out;
}

// Kein Netz (Netzfehler, Timeout, SW-503 `offline`) — Regel in utils/net.js.
// Jede andere Ausnahme ist ein echter Fehler und wird angezeigt, nicht als
// „offline · lokal gesichert" endlos wiederholt.
export const isOfflineError = isNetworkError;

const CACHE_READ_CONCURRENCY = 6;
// = public/sw-domain.js FALLBACK_HEADER: die Antwort kam aus der Werkstatt-
// Ablage des Service Workers, nicht vom Server.
const SW_FALLBACK_HEADER = 'X-SW-Fallback';

function _stamp(v) {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? t : -Infinity;
}

// Jüngerer der beiden Stände eines Abschnitts (nach `updated_at`).
function _newerPage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return _stamp(b.updated_at) > _stamp(a.updated_at) ? b : a;
}

// Gleiche Antwortform wie `/book-editor/:id/contents`, gebaut aus Baum und
// Abschnitten im Content-Cache. Liefert nur, was der Cache hat — ein nicht
// offline gehaltenes Buch hat dort oft nur einzelne Abschnitte (`missing`).
// `extra`: ein zweiter Offline-Stand (die Volltext-Ablage des SW); je
// Abschnitt gewinnt der jüngere, und was nur dort liegt, füllt Lücken.
export async function loadContentsFromCache(bookId, extra = null) {
  const extraById = new Map((extra?.pages || []).map((p) => [Number(p.pageId), p]));
  const tree = await contentRepo.bookTree(bookId);
  const metas = pageMetasFromTree(tree);
  const pages = new Array(metas.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < metas.length) {
      const i = next++;
      const m = metas[i];
      let fromCache = null;
      try {
        const d = await contentRepo.loadPage(m.id);
        fromCache = { pageId: d.id, pageName: d.name, chapterId: m.chapterId, chapterName: m.chapterName, html: d.html || '', updated_at: d.updated_at };
      } catch { /* fehlt im Cache */ }
      const other = extraById.get(Number(m.id));
      pages[i] = _newerPage(fromCache, other ? { ...other, chapterId: m.chapterId, chapterName: m.chapterName } : null);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CACHE_READ_CONCURRENCY, metas.length) }, worker));
  const ok = pages.filter(Boolean);
  return { bookId, chapters: chaptersFromTree(tree), pages: ok, missing: metas.length - ok.length };
}

async function _fetchContents(bookId) {
  let r;
  try {
    r = await fetch('/book-editor/' + bookId + '/contents');
  } catch (e) {
    e.status = 0;
    throw e;
  }
  if (!r.ok) {
    let body = null;
    try { body = await r.clone().json(); } catch { /* kein JSON */ }
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    err.code = body?.error_code || null;
    err.body = body;
    throw err;
  }
  const data = await r.json();
  return { data, fallback: r.headers?.get?.(SW_FALLBACK_HEADER) === 'domain' };
}

// Server-Aggregation, ohne Netz der Cache-Rückfall (`offline: true`).
// Liefert der Service Worker seinen abgelegten Volltext (kein Netz oder
// hängendes Netz), ist der nicht nachgeführt — Writes aus Notebook und
// Bucheditor landen nur im Content-Cache. Dann wird abschnittsweise der
// jüngere Stand genommen, und die Karte gilt als offline.
export async function fetchBookContents(bookId) {
  let res;
  try {
    res = await _fetchContents(bookId);
  } catch (e) {
    if (!isOfflineError(e)) throw e;
    let data;
    try { data = await loadContentsFromCache(bookId); } catch { throw e; }
    if (!data.pages.length) throw e;
    return { ...data, offline: true };
  }
  if (!res.fallback) return res.data;
  let merged = null;
  try { merged = await loadContentsFromCache(bookId, res.data); } catch { /* kein Baum im Cache */ }
  if (merged?.pages.length) return { ...merged, offline: true };
  return { ...res.data, offline: true, missing: res.data.missing || 0 };
}
