'use strict';

// Ein Buch-Bundle (buildBookJson-Format, lib/book-bundle.js) in ein Buch
// schreiben — gemeinsamer Schreibpfad fuer Fassungs-Restore (ganzes Buch und
// einzelne Seite/Kapitel, routes/snapshots/restore.js) und .swbook-Import
// (routes/jobs/book-import.js).
//
//   materializeOps(bookId, ops, ctx, opts)  Kapitel + Seiten anlegen/aktualisieren
//   applyBundleSettings(bookId, settings, { allowLektorBookChat })
//   remapChapterXrefs(html, idMap)          Kapitel-Querverweise auf neue IDs
//
// **Restore an Ort und Stelle:** ein Op, dessen `srcId` im Zielbuch noch als
// Seite/Kapitel existiert, aktualisiert genau diese Zeile (savePage/updateChapter)
// statt sie neu anzulegen. Damit bleiben page_id/chapter_id stabil — und mit
// ihnen alles, was per FK daran haengt (Share-Links samt Leser-Kommentaren,
// Ideen, Blog-/HubSpot-Verknuepfungen, Recherche-Links, Seiten-Historie, Szenen-
// Anker). Ausserdem matchen Reader-Diff, Fassungs-Vergleich und Drift-Check
// weiter ueber srcId. Neu angelegt wird nur, was im Ziel fehlt.

const contentStore = require('./content-store');
const logger = require('../logger');
const bookOrder = require('../db/book-order');
const { orderTreeFromOps } = require('./book-bundle');
const { getPageImage, restorePageImages } = require('../db/page-images');
const { XREF_HINT } = require('./xref-index');
const { xrefModules } = require('./esm-bridge');
const { sessionEmail } = require('./acl');

// ── Querverweise ─────────────────────────────────────────────────────────────
// `data-xref-id` eines Kapitel-Verweises ist die chapter_id. Wird ein Kapitel
// neu angelegt (andere ID als im Bundle), zeigen Verweise darauf sonst ins
// Leere. idMap: srcChapterId -> neue chapter_id (nur tatsaechlich geaenderte).
async function remapChapterXrefs(html, idMap) {
  if (!html || !idMap || !idMap.size || html.indexOf(XREF_HINT) === -1) return html || '';
  const { XREF_SEL, XREF_ATTR_KIND, XREF_ATTR_ID } = await xrefModules({ withRender: false });
  const { parseHTML } = require('linkedom');
  const { document } = parseHTML(`<!doctype html><html><body><div id="r">${html}</div></body></html>`);
  const root = document.getElementById('r');
  if (!root) return html;
  let changed = false;
  for (const el of root.querySelectorAll(XREF_SEL)) {
    if (el.getAttribute(XREF_ATTR_KIND) !== 'chapter') continue;
    const next = idMap.get(Number(el.getAttribute(XREF_ATTR_ID)));
    if (next == null) continue;
    el.setAttribute(XREF_ATTR_ID, String(next));
    changed = true;
  }
  return changed ? root.innerHTML : html;
}

// ── Einstellungen ───────────────────────────────────────────────────────────
// Bundle-Settings ueber den aktuellen Stand legen: nur Keys, die das Bundle
// traegt, werden ueberschrieben — aeltere Fassungen/.swbook-Dateien kennen
// spaetere Felder nicht, die bleiben dann wie sie sind. Die ACL-Freigabe
// `allow_lektor_book_chat` kommt nie aus dem Bundle (Aufrufer entscheidet).
function applyBundleSettings(bookId, settings, { allowLektorBookChat = null } = {}) {
  if (!settings || typeof settings !== 'object') return;
  const bs = require('../db/book-settings');
  const cur = bs.getBookSettings(bookId);
  const has = (k) => Object.prototype.hasOwnProperty.call(settings, k);
  const v = (k) => (has(k) ? settings[k] : cur[k]);
  const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

  bs.saveBookSettings(
    bookId, v('language') || 'de', v('region') || 'CH', v('buchtyp') || null, v('buch_kontext') || null,
    v('erzaehlperspektive') || null, v('erzaehlzeit') || null, v('is_finished') ? 1 : 0,
    allowLektorBookChat == null ? (cur.allow_lektor_book_chat ? 1 : 0) : (allowLektorBookChat ? 1 : 0),
    num(v('daily_goal_chars')), v('orte_real') ? 1 : 0, v('schauplatz_land') || null,
    num(v('goal_target_chars')), v('goal_deadline') || null, v('stilprofil') || null,
    v('zeitlinie_real') ? 1 : 0, v('exclude_from_stats') ? 1 : 0, v('weltfakten_real_pruefen') ? 1 : 0,
  );
  if (has('entities_enabled')) bs.setBookEntitiesEnabled(bookId, settings.entities_enabled ? 1 : 0);
  if (has('textsorte')) bs.setBookTextsorte(bookId, settings.textsorte);
  const CITATION = ['citation_style', 'bibliography_enabled', 'bibliography_title', 'bibliography_scope',
    'bibliography_in_blog', 'citation_notes'];
  if (CITATION.some(has)) {
    bs.setBookCitationSettings(bookId, Object.fromEntries(CITATION.map(k => [k, v(k)])));
  }
  if (has('figure_numbering') || has('table_numbering')) {
    bs.setBookXrefSettings(bookId, { figure_numbering: v('figure_numbering'), table_numbering: v('table_numbering') });
  }
  if (has('research_profile') || has('research_domains')) {
    bs.setBookResearchSettings(bookId, { research_profile: v('research_profile'), research_domains: v('research_domains') });
  }
  if (has('ideen_stages') && Array.isArray(settings.ideen_stages)) {
    bs.setBookIdeenStages(bookId, settings.ideen_stages);
  }
}

// ── Kapitel + Seiten ────────────────────────────────────────────────────────
// Bild-BLOBs, die das Bundle mitfuehrt, nur dort neu einfuegen, wo die
// referenzierte page_images-Zeile dieser Seite nicht mehr existiert (sonst
// entstuende bei jedem Restore ein Duplikat). Gibt das (ggf. umgeschriebene) HTML.
function _restoreMissingImages(pageId, html, images) {
  if (!Array.isArray(images) || !images.length) return html;
  const missing = images.filter((im) => {
    const row = im?.oldId != null ? getPageImage(im.oldId) : null;
    return !(row && row.page_id === pageId);
  });
  if (!missing.length) return html;
  return restorePageImages(pageId, html, missing) ?? html;
}

// ops aus planFromNodes. Optionen:
//   replace              true = das Buch hat danach EXAKT den Stand der Ops: was
//                        nicht zugeordnet wurde, wird geloescht (Seiten in den
//                        Papierkorb), die Reihenfolge inkl. Interleaving per
//                        putOrder gesetzt. false = nur zuordnen/anlegen, nichts
//                        loeschen, neue Knoten reiht ensureTree ein.
//   rootParentChapterId  Eltern-Kapitel fuer Top-Level-Ops (Teilbaum-Restore).
//   onProgress(done, total)
// Wirft nicht pro Op: Einzelfehler zaehlen in `failed` (Aufrufer meldet sie).
async function materializeOps(bookId, ops, ctx, { replace = false, rootParentChapterId = null, onProgress = null } = {}) {
  const result = {
    chapterIdBySrc: new Map(), pageIdBySrc: new Map(),
    created: { pages: 0, chapters: 0 }, updated: { pages: 0, chapters: 0 },
    deleted: { pages: 0, chapters: 0 }, failed: 0,
  };
  const [curChapters, curPages] = await Promise.all([
    contentStore.listChapters(bookId, ctx), contentStore.listPages(bookId, ctx),
  ]);
  const chapterById = new Map(curChapters.map(c => [c.id, c]));
  const pageById = new Map(curPages.map(p => [p.id, p]));
  const chapterIdByTemp = new Map();
  const pageIdByOp = new Map();
  const xrefMap = new Map();
  const keptChapters = new Set();
  const keptPages = new Set();
  let done = 0;
  const tick = () => { done += 1; if (onProgress) onProgress(done, ops.length); };
  const parentOf = (o) => (o.parentTempId == null
    ? rootParentChapterId
    : (chapterIdByTemp.get(o.parentTempId) ?? rootParentChapterId));

  // Pass 1: Kapitel. Vor den Seiten, damit jeder Querverweis — auch einer auf
  // ein spaeter im Buch stehendes Kapitel — beim Schreiben schon seine Ziel-ID kennt.
  for (const o of ops) {
    if (o.op !== 'chapter') continue;
    try {
      const cur = o.srcId != null ? chapterById.get(o.srcId) : null;
      if (cur && !keptChapters.has(cur.id)) {
        const patch = {};
        if ((cur.name || '') !== (o.name || '')) patch.name = o.name || '';
        if (typeof o.excluded === 'boolean' && !!cur.excluded !== o.excluded) patch.excluded = o.excluded;
        if (Object.keys(patch).length) {
          await contentStore.updateChapter(cur.id, patch, ctx);
          result.updated.chapters += 1;
        }
        chapterIdByTemp.set(o.tempId, cur.id);
        keptChapters.add(cur.id);
        result.chapterIdBySrc.set(o.srcId, cur.id);
      } else {
        const ch = await contentStore.createChapter(
          { book_id: bookId, name: o.name || '', parent_chapter_id: parentOf(o) }, ctx);
        if (o.excluded === true) await contentStore.updateChapter(ch.id, { excluded: true }, ctx);
        chapterIdByTemp.set(o.tempId, ch.id);
        keptChapters.add(ch.id);
        result.created.chapters += 1;
        if (o.srcId != null) {
          result.chapterIdBySrc.set(o.srcId, ch.id);
          if (ch.id !== o.srcId) xrefMap.set(o.srcId, ch.id);
        }
      }
    } catch (e) {
      result.failed += 1;
      logger.warn(`Bundle-Apply: Kapitel «${o.name}» fehlgeschlagen (book=${bookId}): ${e.message}`);
    }
    tick();
  }

  // Pass 2: Seiten.
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    if (o.op !== 'page') continue;
    try {
      let html = await remapChapterXrefs(o.html || '', xrefMap);
      const cur = o.srcId != null ? pageById.get(o.srcId) : null;
      if (cur && !keptPages.has(cur.id)) {
        html = _restoreMissingImages(cur.id, html, o.images);
        const full = await contentStore.loadPage(cur.id, ctx);
        const patch = {};
        if ((full?.html || '') !== html) { patch.html = html; patch.source = 'import'; }
        if ((cur.name || '') !== (o.name || '')) patch.name = o.name || '';
        if (Object.keys(patch).length) {
          await contentStore.savePage(cur.id, patch, ctx);
          result.updated.pages += 1;
        }
        pageIdByOp.set(i, cur.id);
        keptPages.add(cur.id);
        result.pageIdBySrc.set(o.srcId, cur.id);
      } else {
        const created = await contentStore.createPage(
          { book_id: bookId, chapter_id: parentOf(o), name: o.name || '', html }, ctx);
        if (created?.id && o.images?.length) {
          const rewritten = restorePageImages(created.id, html, o.images);
          if (rewritten != null) await contentStore.savePage(created.id, { html: rewritten, source: 'import' }, ctx);
        }
        pageIdByOp.set(i, created.id);
        keptPages.add(created.id);
        result.created.pages += 1;
        if (o.srcId != null) result.pageIdBySrc.set(o.srcId, created.id);
      }
    } catch (e) {
      result.failed += 1;
      logger.warn(`Bundle-Apply: Seite «${o.name}» fehlgeschlagen (book=${bookId}): ${e.message}`);
    }
    tick();
  }

  if (!replace) {
    try { bookOrder.ensureTree(bookId); } catch (e) { logger.warn(`Bundle-Apply ensureTree (book=${bookId}): ${e.message}`); }
    return result;
  }

  // Pass 3 (replace): was der Ziel-Stand nicht kennt, entfernen. Seiten zuerst —
  // pages.chapter_id/chapters.parent_chapter_id sind ON DELETE SET NULL, ein
  // geloeschtes Kapitel nimmt nichts mit. Geloeschte Seiten landen im Papierkorb
  // (es sind nur die seit dem Ziel-Stand hinzugekommenen).
  for (const p of curPages) {
    if (keptPages.has(p.id)) continue;
    try { await contentStore.deletePage(p.id, ctx); result.deleted.pages += 1; }
    catch (e) { result.failed += 1; logger.warn(`Bundle-Apply: Loeschen Seite ${p.id} fehlgeschlagen: ${e.message}`); }
  }
  for (const c of curChapters) {
    if (keptChapters.has(c.id)) continue;
    try { await contentStore.deleteChapter(c.id, ctx); result.deleted.chapters += 1; }
    catch (e) { result.failed += 1; logger.warn(`Bundle-Apply: Loeschen Kapitel ${c.id} fehlgeschlagen: ${e.message}`); }
  }

  // Reihenfolge + Hierarchie exakt nach Ziel-Stand (inkl. Interleaving).
  try {
    bookOrder.putOrder(bookId, orderTreeFromOps(ops, chapterIdByTemp, pageIdByOp), sessionEmail(ctx));
  } catch (e) {
    result.failed += 1;
    logger.warn(`Bundle-Apply putOrder fehlgeschlagen (book=${bookId}): ${e.message}`);
    bookOrder.clearOrder(bookId);
    try { bookOrder.ensureTree(bookId); } catch { /* bookTree heilt beim naechsten Read */ }
  }
  return result;
}

module.exports = { materializeOps, applyBundleSettings, remapChapterXrefs };
