'use strict';
// Content-Store-Facade über das localdb-Backend. Dünner Wrapper, der Schreib-
// Chokepoint für Page-Revisions und FTS-Index-Hooks bleibt und Tree-Overlay
// aus book_order anwendet.
//
// Konsumenten importieren `require('../lib/content-store')` — die Auflösung
// trifft `lib/content-store/index.js` (Node-Folder-Resolution).

const localdbBackend = require('./backends/localdb');
const pageTrash = require('./backends/localdb-delete');
const { restorePageImages } = require('../../db/page-images');
const pageRevisions = require('../../db/page-revisions');
const bookOrder = require('../../db/book-order');
const deviceTokens = require('../../db/device-tokens');
const booksDb = require('../../db/books');
const { uaLabel } = require('../ua-label');
const { emitBookChange } = require('../book-events');
const logger = require('../../logger');

let _searchIndexCached = null;
function _searchIndex() {
  if (_searchIndexCached !== null) return _searchIndexCached;
  try { _searchIndexCached = require('../search'); }
  catch (e) {
    logger.warn(`[content-store] searchIndex nicht verfuegbar: ${e.message}`);
    _searchIndexCached = false;
  }
  return _searchIndexCached || null;
}

// Fund-Index der Quellen-Belege (source_citations). Lazy wie der FTS-Index,
// damit ein Ladefehler den Content-Store nicht mitnimmt.
let _citeIndexCached = null;
function _citeIndex() {
  if (_citeIndexCached !== null) return _citeIndexCached;
  try { _citeIndexCached = require('../cite-index'); }
  catch (e) {
    logger.warn(`[content-store] citeIndex nicht verfuegbar: ${e.message}`);
    _citeIndexCached = false;
  }
  return _citeIndexCached || null;
}

// Index der Querverweise (xref_links + xref_anchors). Lazy wie der Beleg-Index,
// damit ein Ladefehler den Content-Store nicht mitnimmt.
let _xrefIndexCached = null;
function _xrefIndex() {
  if (_xrefIndexCached !== null) return _xrefIndexCached;
  try { _xrefIndexCached = require('../xref-index'); }
  catch (e) {
    logger.warn(`[content-store] xrefIndex nicht verfuegbar: ${e.message}`);
    _xrefIndexCached = false;
  }
  return _xrefIndexCached || null;
}

// Extrahiert User-Email aus ctx, wenn es ein Express-Request ist. Sonst null
// (Cron-Jobs, Worker mit Token-only-ctx).
function _userEmailFromCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  return ctx.session?.user?.email || null;
}

// Bekannte Plattform-Codes auf huebsche Schreibweise mappen; sonst erstes
// Zeichen gross. Gilt fuer den Request-Header und das statische Token-Feld
// gleichermassen, damit das Label konsistent aussieht.
const _PLATFORM_LABELS = {
  macos: 'macOS', ios: 'iOS', android: 'Android',
  windows: 'Windows', linux: 'Linux', web: 'Web',
};
function _prettyPlatform(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const s = p.trim();
  return _PLATFORM_LABELS[s.toLowerCase()] || (s.charAt(0).toUpperCase() + s.slice(1));
}

// Beschreibt den schreibenden Client fuer die Revision. Reihenfolge bei
// Device-Token-Auth:
//   1. Per-Request-Selbstidentifikation (X-Client-Device/-Platform, von
//      lib/device-auth auf session.user gelegt) — korrekt auch bei einem Token,
//      das auf mehreren Geraeten (Mac + Android) geteilt wird.
//   2. statische Token-Felder (device_name + platform) — sauberer Weg bei
//      „ein Token pro Geraet".
// Browser → User-Agent ("<Browser> · <OS>"). null fuer server-seitige Schreiber
// ohne Request-Kontext (Cron/Jobs).
function _clientFromCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  const u = ctx.session?.user;
  if (u?.via === 'device_token') {
    const reqDevice = typeof u.clientDevice === 'string' && u.clientDevice.trim() ? u.clientDevice.trim() : null;
    const reqPlatform = _prettyPlatform(u.clientPlatform);
    if (reqDevice || reqPlatform) {
      if (reqDevice && reqPlatform) return `${reqDevice} · ${reqPlatform}`;
      return reqDevice || `${reqPlatform}-App`;
    }
    try {
      const dev = u.tokenId ? deviceTokens.getDeviceTokenById(u.tokenId) : null;
      const platform = _prettyPlatform(dev?.platform) || 'macOS';
      return dev?.device_name ? `${dev.device_name} · ${platform}` : `${platform}-App`;
    } catch { return 'macOS-App'; }
  }
  const ua = typeof ctx.get === 'function'
    ? ctx.get('user-agent')
    : (ctx.headers && ctx.headers['user-agent']) || null;
  return ua ? uaLabel(ua) : null;
}

// ── Books ────────────────────────────────────────────────────────────────────
async function listBooks(ctx)                 { return localdbBackend.listBooks(ctx); }
async function loadBook(bookId, ctx)          { return localdbBackend.loadBook(bookId, ctx); }
/**
 * Stilprofil eines frisch angelegten Buchs aus dem Autorenprofil des Anlegers
 * vorbelegen. Non-fatal — eine Vorbelegung darf nie eine Buchanlage verhindern.
 *
 * Hier und nicht in den sechs Aufrufern von `createBook`: das ist der einzige
 * Punkt, durch den JEDES neue Buch geht (Karte, Ordner-Import,
 * Manuskript-Import, Buch-Import, Demo-Seed). Sechs Kopien waeren die Drift,
 * bei der ein Import-Weg die Vorbelegung still verliert.
 *
 * Der Autor kommt aus dem Body (`owner_email`, die Import-Jobs setzen ihn) oder
 * sonst aus der Session — `books.owner_email` taugt hier nicht: die Karte setzt
 * den Eigentuemer erst NACH `createBook`.
 *
 * `seedBookStilprofil` schreibt nur in eine leere Stelle. Ein Buch-Import, der
 * danach die Einstellungen aus seinem Bundle einspielt, gewinnt also — richtig
 * so: eine wiederhergestellte Fassung ist ueber ihren eigenen Stil autoritativ.
 */
function _seedStilprofilFromAuthor(bookId, email) {
  if (!bookId || !email) return;
  try {
    const { getAuthorProfileRow } = require('../../db/author-profile');
    const { seedBookStilprofil } = require('../../db/book-settings');
    const text = getAuthorProfileRow(email)?.profil_text || '';
    if (text) seedBookStilprofil(bookId, text);
  } catch (e) {
    logger.warn(`Stilprofil-Vorbelegung fuer book=${bookId} fehlgeschlagen: ${e.message}`);
  }
}

async function createBook(body, ctx) {
  const created = await localdbBackend.createBook(body, ctx);
  if (created?.id) {
    _searchIndex()?.upsertBookMeta(created.id);
    _seedStilprofilFromAuthor(created.id, body?.owner_email || _userEmailFromCtx(ctx));
  }
  return created;
}
async function updateBook(bookId, body, ctx) {
  const updated = await localdbBackend.updateBook(bookId, body, ctx);
  _searchIndex()?.upsertBookMeta(bookId);
  return updated;
}
// Eigentuemer eines Buchs setzen (`books.owner_email`). Synchron — der
// book_access-Grant daneben laeuft in derselben Transaktion (Admin-Zuweisung)
// bzw. direkt danach (Anlage-Pfade mit `onlyIfUnset`).
function setBookOwner(bookId, email, opts) {
  return booksDb.setBookOwner(bookId, email, opts);
}
async function deleteBook(bookId, ctx) {
  const result = await localdbBackend.deleteBook(bookId, ctx);
  _searchIndex()?.removeAllForBook(bookId);
  return result;
}

// ── Chapters ────────────────────────────────────────────────────────────────
async function listChapters(bookId, ctx)              { return localdbBackend.listChapters(bookId, ctx); }
async function loadChapter(chapterId, ctx)            { return localdbBackend.loadChapter(chapterId, ctx); }
// `body.after_chapter_id`: neues Kapitel als Geschwister direkt hinter diesem
// Anker. Die Reihenfolge lebt in book_order (SSoT, bookTree liest daraus) —
// `position` allein wirkt dort nicht: reconcile haengt ein neues Kapitel ans
// Ende seines Parents. Deshalb hier in order_json umhaengen; putOrder
// materialisiert danach die Positionen lueckenlos.
async function createChapter(body, ctx) {
  const afterId = Number.isFinite(body?.after_chapter_id) ? body.after_chapter_id : null;
  let anchor = null;
  let input = body;
  if (afterId != null) {
    anchor = await localdbBackend.loadChapter(afterId, ctx);
    if (anchor.book_id !== body.book_id) {
      const err = new Error(`Chapter ${afterId} not in book ${body.book_id}`);
      err.code = 'NOT_FOUND';
      err.status = 404;
      throw err;
    }
    input = { book_id: body.book_id, name: body.name, parent_chapter_id: anchor.parent_chapter_id ?? undefined };
  }
  let created = await localdbBackend.createChapter(input, ctx);
  if (created?.id && anchor) {
    _placeChapterAfter(body.book_id, created.id, anchor.id);
    created = await localdbBackend.loadChapter(created.id, ctx);
  }
  if (created?.id) _searchIndex()?.upsertChapter(created.id);
  return created;
}

function _placeChapterAfter(bookId, chapterId, anchorId) {
  const ordered = bookOrder.ensureTree(bookId);
  const tree = JSON.parse(JSON.stringify(ordered?.tree || []));
  const take = (nodes) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type !== 'chapter') continue;
      if (n.id === chapterId) return nodes.splice(i, 1)[0];
      const hit = take(n.children || []);
      if (hit) return hit;
    }
    return null;
  };
  const insert = (nodes, node) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type !== 'chapter') continue;
      if (n.id === anchorId) { nodes.splice(i + 1, 0, node); return true; }
      if (insert(n.children || [], node)) return true;
    }
    return false;
  };
  const node = take(tree) || { type: 'chapter', id: chapterId, children: [] };
  if (!insert(tree, node)) return;
  // updated_by bleibt beim letzten echten Umsortierer — Anlegen ist kein Reorder.
  bookOrder.putOrder(bookId, tree, ordered?.updated_by ?? null);
}
async function updateChapter(chapterId, body, ctx) {
  const updated = await localdbBackend.updateChapter(chapterId, body, ctx);
  _searchIndex()?.upsertChapter(chapterId);
  return updated;
}
async function deleteChapter(chapterId, ctx) {
  const result = await localdbBackend.deleteChapter(chapterId, ctx);
  _searchIndex()?.remove('chapter', chapterId);
  return result;
}

// ── Pages ────────────────────────────────────────────────────────────────────
async function listPages(bookId, ctx)         { return localdbBackend.listPages(bookId, ctx); }
async function loadPage(pageId, ctx)          { return localdbBackend.loadPage(pageId, ctx); }

const _SOURCE_FALLBACK = 'main';

async function savePage(pageId, body, ctx) {
  // Meta-Felder fuer Revision-Schreiben aus dem Body ziehen, bevor er ans
  // Backend geht — Backend ignoriert unbekannte Keys, aber wir wollen sie
  // erst gar nicht uebermitteln.
  const rawSource = body && typeof body === 'object' ? body.source : null;
  const source = pageRevisions.VALID_SOURCES.has(rawSource) ? rawSource : _SOURCE_FALLBACK;
  const summary = body && typeof body === 'object' && typeof body.summary === 'string'
    ? body.summary.slice(0, 500)
    : null;
  const cleanBody = { ...body };
  delete cleanBody.source;
  delete cleanBody.summary;

  const saved = await localdbBackend.savePage(pageId, cleanBody, ctx);

  // Revision nur schreiben, wenn der Save den Body geaendert hat. Reine
  // Rename- oder Reorder-Saves erzeugen keinen page_revisions-Eintrag —
  // sonst quillt die Tabelle bei Drag-Reorder ueber.
  if (typeof body?.html === 'string' && saved) {
    try {
      pageRevisions.insert({
        pageId,
        bookId: saved.book_id,
        bodyHtml: saved.html || '',
        source,
        userEmail: _userEmailFromCtx(ctx),
        client: _clientFromCtx(ctx),
        summary,
      });
    } catch (e) {
      // Revision-Failures duerfen den Save nicht abbrechen.
      logger.warn(`page_revisions insert fehlgeschlagen (page=${pageId}): ${e.message}`);
    }
  }

  if (saved?.id) _searchIndex()?.upsertPage(saved.id);
  if (saved?.book_id) emitBookChange(saved.book_id, _userEmailFromCtx(ctx), cleanBody.device_id);

  // Belege der Seite neu indizieren — nur bei Body-Change (Rename/Reorder
  // aendern nichts an den Chips). Non-fatal wie der Revision-Insert.
  if (typeof body?.html === 'string' && saved?.id) {
    await _citeIndex()?.reindexPageCitationsSafe(saved.id, saved.html || '');
    await _xrefIndex()?.reindexPageXrefsSafe(saved.id, saved.html || '');
  }

  return saved;
}

async function createPage(body, ctx) {
  const created = await localdbBackend.createPage(body, ctx);
  if (created?.id) _searchIndex()?.upsertPage(created.id);
  // Neuanlage mit Belegen im HTML: Import, Blog-Pull, Snapshot-Restore und
  // Buch-Migration laufen hier durch, nicht ueber savePage.
  if (created?.id) await _citeIndex()?.reindexPageCitationsSafe(created.id, created.html || '');
  if (created?.id) await _xrefIndex()?.reindexPageXrefsSafe(created.id, created.html || '');
  if (created?.book_id) emitBookChange(created.book_id, _userEmailFromCtx(ctx), body?.device_id);
  return created;
}

// Abschnitt teilen: Kopf bleibt auf `pageId`, Schwanz wird neue Seite direkt
// dahinter im selben Kapitel. Die Struktur (beide Writes, Reihenfolge, Bilder)
// ist eine Transaktion im Backend; hier laufen die Nachzuege, die auch savePage/
// createPage machen: Revision fuer BEIDE Seiten (die Ausgangsseite traegt den
// Stand vor dem Teilen in ihrer Geschichte, die neue Seite startet mit dem
// Schwanz), FTS-, Beleg- und Verweis-Index, Buch-Event.
// `opts`: { headHtml, tailHtml, newName, expectedUpdatedAt?, deviceId? }.
async function splitPage(pageId, opts, ctx) {
  const userEmail = _userEmailFromCtx(ctx);
  const client = _clientFromCtx(ctx);
  // Stand VOR dem Teilen sicher in der Geschichte: hat die Seite nie eine
  // Revision bekommen (Import, Alt-Bestand), waere der ungeteilte Text sonst
  // nirgends mehr. Identisch zur juengsten Revision → insert dedupliziert.
  try {
    const before = await localdbBackend.loadPage(pageId, ctx);
    pageRevisions.insert({
      pageId, bookId: before.book_id, bodyHtml: before.html || '',
      source: 'main', userEmail, client, summary: 'before split',
    });
  } catch (e) {
    if (e?.code === 'NOT_FOUND') throw e;
    logger.warn(`page_revisions insert fehlgeschlagen (vor split page=${pageId}): ${e.message}`);
  }
  const { head, tail } = await require('./backends/localdb-split').splitPage(pageId, {
    ...opts, userEmail, deviceId: opts?.deviceId || null,
  });
  for (const [page, summary] of [[head, `split → #${tail.id}`], [tail, `split from #${pageId}`]]) {
    try {
      pageRevisions.insert({
        pageId: page.id, bookId: page.book_id, bodyHtml: page.html || '',
        source: 'main', userEmail, client, summary,
      });
    } catch (e) {
      logger.warn(`page_revisions insert fehlgeschlagen (split page=${page.id}): ${e.message}`);
    }
    _searchIndex()?.upsertPage(page.id);
    await _citeIndex()?.reindexPageCitationsSafe(page.id, page.html || '');
    await _xrefIndex()?.reindexPageXrefsSafe(page.id, page.html || '');
  }
  emitBookChange(head.book_id, userEmail, opts?.deviceId || null);
  return { head, tail };
}

// Fehlende data-bid auf einer bestehenden Seite nachziehen (additiv, ohne
// updated_at/Revision). Text-Inhalt bleibt gleich → kein FTS-Reindex noetig.
async function backfillBlockIds(pageId, ctx) {
  return localdbBackend.backfillBlockIds(pageId, ctx);
}

// Personenbezug eines geloeschten Kontos aus dem Seiten-Snapshot nehmen
// (`pages.last_editor_email`). Einziger Konsument: lib/account-delete.js.
// Synchron, weil es nur ein UPDATE ohne Index-/Revisions-Nachlauf ist.
function anonymizeUser(email) {
  return localdbBackend.anonymizeUser(email);
}
async function deletePage(pageId, ctx, opts = {}) {
  const result = await localdbBackend.deletePage(pageId, opts);
  _searchIndex()?.remove('page', pageId);
  emitBookChange(result?.bookId, opts.deletedBy || _userEmailFromCtx(ctx), opts.deviceId);
  return result;
}

// ── Papierkorb ───────────────────────────────────────────────────────────────
// Geloeschte Seiten, deren Inhalt `deletePage` gesichert hat (page_deletions).
function listPageTrash(bookId) {
  return pageTrash.listTrash(bookId);
}

function _trashErr(code, status) {
  const e = new Error(code);
  e.code = code;
  e.status = status;
  return e;
}

// Legt die Seite aus dem Papierkorb neu an (neue page_id) — im alten Kapitel,
// sonst auf Buch-Ebene — samt den beim Loeschen gesicherten Bildern. Die
// Versionsgeschichte der alten Seite kommt nicht zurueck (CASCADE beim Loeschen).
// `bookId` bindet den Eintrag an das Buch der Route (ACL-Scope).
async function restoreDeletedPage(deletionId, bookId, ctx) {
  const entry = pageTrash.getTrashEntry(deletionId);
  if (!entry || entry.body_html == null || entry.book_id !== bookId) throw _trashErr('TRASH_NOT_FOUND', 404);
  if (!pageTrash.markRestored(deletionId)) throw _trashErr('ALREADY_RESTORED', 409);
  let created;
  try {
    const chapterId = entry.chapter_book_id === entry.book_id ? entry.chapter_id : null;
    created = await createPage({
      book_id: entry.book_id, chapter_id: chapterId, name: entry.page_name || '', html: entry.body_html,
    }, ctx);
  } catch (e) {
    pageTrash.unmarkRestored(deletionId);
    throw e;
  }
  let images = null;
  try { images = entry.images_json ? JSON.parse(entry.images_json) : null; }
  catch { logger.warn(`Papierkorb ${deletionId}: images_json unlesbar, Seite ohne Bilder wiederhergestellt.`); }
  if (created?.id && images?.length) {
    const rewritten = restorePageImages(created.id, entry.body_html, images);
    if (rewritten != null) {
      try { await savePage(created.id, { html: rewritten, source: 'import' }, ctx); }
      catch (e) { logger.warn(`Papierkorb ${deletionId}: Bild-Rewrite fehlgeschlagen: ${e.message}`); }
    }
  }
  return { id: created.id, book_id: entry.book_id, chapter_id: created.chapter_id ?? null, name: created.name };
}

// Seite in ein anderes Buch verschieben (Re-Parent, page_id bleibt stabil). Die
// raw-DB-Mutation (inkl. FK-Kappen) liegt im Backend; hier werden die
// book_order-Overlays beider Buecher gegen den neuen Stand reconciled (SSoT) und
// der FTS-Index neu unter dem Zielbuch verankert.
async function movePage(pageId, body, ctx) {
  const result = await localdbBackend.movePage(pageId, body, ctx);
  try {
    bookOrder.ensureTree(result.sourceBookId);
    bookOrder.ensureTree(result.targetBookId);
  } catch (e) {
    logger.warn(`[content-store] movePage ensureTree fehlgeschlagen (page=${pageId}): ${e.message}`);
  }
  _searchIndex()?.upsertPage(pageId);
  // Semantischer Index: die Chunks tragen die alte book_id und blieben sonst bis
  // zum nächsten Lauf in der Suche des alten Buchs. Der Auto-Index des Zielbuchs
  // (emitBookChange unten) bettet die Seite dort neu ein.
  try { require('../../db/semantic-chunks').remove('page', pageId); }
  catch (e) { logger.warn(`[content-store] movePage Semantik-Chunks nicht entfernt (page=${pageId}): ${e.message}`); }
  // Buchwechsel: die Chips zeigen jetzt auf Quellen eines anderen Buchs. Der
  // Buch-Guard in replacePageCitations verwirft sie beim Reindex — die Seite
  // zeigt danach Belege ohne Ziel statt falscher Fundstellen im Zielbuch.
  // Dasselbe gilt fuer Querverweise: die Kapitel-Ziele liegen im alten Buch, der
  // Buch-Guard in replacePageXrefs verwirft sie beim Reindex. Die Anker der
  // Seite (ihre eigenen Abbildungen) wandern dagegen mit und bleiben gueltig.
  try {
    const page = await localdbBackend.loadPage(pageId, ctx);
    await _citeIndex()?.reindexPageCitationsSafe(pageId, page?.html || '');
    await _xrefIndex()?.reindexPageXrefsSafe(pageId, page?.html || '');
  } catch (e) {
    logger.warn(`[content-store] movePage Beleg-/Verweis-Reindex fehlgeschlagen (page=${pageId}): ${e.message}`);
  }
  emitBookChange(result.sourceBookId, _userEmailFromCtx(ctx), body?.device_id);
  emitBookChange(result.targetBookId, _userEmailFromCtx(ctx), body?.device_id);
  return result;
}

// ── Higher-level helpers ────────────────────────────────────────────────────
// bookTree konsumiert raw-Daten und ordnet sie nach book_order (SSoT).
// Fehlt die Row, wird sie aus dem aktuellen position-Stand
// initialisiert (Auto-Init).
async function bookTree(bookId, ctx) {
  const raw = await localdbBackend.bookTree(bookId, ctx);
  const ordered = bookOrder.ensureTree(bookId);
  if (!ordered?.tree?.length) return raw;
  return _applyOrder(raw, ordered.tree);
}

// Output-Format: chapters enthaelt nur Top-Level-Kapitel. Jedes Kapitel hat
// pages[] (direkt enthaltene Seiten) + subchapters[] (nested, gleiche Shape).
// Konsumenten, die alle Seiten flach brauchen, nutzen flattenTree().
function _applyOrder(raw, tree) {
  const chaptersById = new Map((raw.chapters || []).map(c => [c.id, c]));
  const pagesById = new Map();
  for (const c of (raw.chapters || [])) for (const p of (c.pages || [])) pagesById.set(p.id, p);
  for (const p of (raw.topPages || [])) pagesById.set(p.id, p);

  function buildChapter(entry) {
    const ch = chaptersById.get(entry.id);
    if (!ch) return null;
    const pages = [];
    const subchapters = [];
    for (const child of (entry.children || [])) {
      if (child.type === 'chapter') {
        const sub = buildChapter(child);
        if (sub) subchapters.push(sub);
      } else if (child.type === 'page') {
        const p = pagesById.get(child.id);
        if (p) pages.push({ ...p, chapter_id: ch.id });
      }
    }
    return { ...ch, pages, subchapters };
  }

  const chaptersOut = [];
  const topPages = [];
  for (const entry of tree) {
    if (entry.type === 'chapter') {
      const built = buildChapter(entry);
      if (built) chaptersOut.push(built);
    } else if (entry.type === 'page') {
      const p = pagesById.get(entry.id);
      if (p) topPages.push({ ...p, chapter_id: null });
    }
  }
  return { chapters: chaptersOut, topPages };
}

// Flacht den bookTree-Output in eine depth-first-Liste { page, chapterId,
// chapterName, depth }-Records aus. chapterName ist das direkt umschliessende
// Kapitel (max-tiefe Vorfahr); fuer Top-Level-Seiten null.
function flattenTree(tree) {
  const out = [];
  function walkChapters(chapters, depth) {
    for (const c of chapters) {
      for (const p of (c.pages || [])) {
        out.push({ page: p, chapterId: c.id, chapterName: c.name, depth });
      }
      walkChapters(c.subchapters || [], depth + 1);
    }
  }
  walkChapters(tree.chapters || [], 1);
  for (const p of (tree.topPages || [])) {
    out.push({ page: p, chapterId: null, chapterName: null, depth: 0 });
  }
  return out;
}

// Iteriert alle Kapitel des Trees (Top-Level + Sub-Kapitel rekursiv).
function walkAllChapters(tree, cb) {
  function walk(chapters, depth) {
    for (const c of chapters) {
      cb(c, depth);
      walk(c.subchapters || [], depth + 1);
    }
  }
  walk(tree.chapters || [], 1);
}

async function loadPagesBatch(pageMetas, ctx, opts)   { return localdbBackend.loadPagesBatch(pageMetas, ctx, opts); }
async function searchPages(query, opts, ctx)          { return localdbBackend.searchPages(query, opts, ctx); }
function pagesChangedSince(bookId, cursor, limit)     { return localdbBackend.pagesChangedSince(bookId, cursor, limit); }
// { bid → page_id | null }: erste Seite des Buchs, deren HTML den Block (data-bid) traegt.
function findPagesByBlockIds(bookId, bids)            { return require('./backends/localdb-blocks').findPagesByBlockIds(bookId, bids); }

module.exports = {
  listBooks, loadBook, createBook, updateBook, deleteBook, setBookOwner,
  listChapters, loadChapter, createChapter, updateChapter, deleteChapter,
  listPages, loadPage, savePage, createPage, deletePage, movePage, splitPage, backfillBlockIds,
  listPageTrash, restoreDeletedPage,
  anonymizeUser,
  bookTree, flattenTree, walkAllChapters, loadPagesBatch, searchPages, pagesChangedSince, findPagesByBlockIds,
  _clientFromCtx,
};
