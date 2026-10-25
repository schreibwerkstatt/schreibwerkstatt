'use strict';

// Selbsttragende Momentaufnahme des aktuellen Buchstands bauen — gemeinsame Basis
// fuer „Fassung speichern", die Auto-Sicherung vor einem Restore, die Auto-Fassung
// beim Fertig-Markieren (captureSnapshot) und den Drift-Check (light).
//   content_json   = buildBookJson({ book, settings, nodes })   (Seiten-HTML inline)
//   extras_json    = collectExtras(bookId, { analysis, lektorat })
//   extras_summary = extrasSummary(extras) — Zaehl-Uebersicht fuer den Reader

const logger = require('../../logger');
const contentStore = require('../../lib/content-store');
const { getBookSettings } = require('../../db/schema');
const { treeToNodes, buildBookJson } = require('../../lib/book-bundle');
const { collectExtras } = require('../../db/book-migration-data');
const { htmlToPlainText } = require('../../lib/html-text');
const { sessionEmail } = require('../../lib/acl');
const { imageHash } = require('../../lib/snapshot-export');
const bookOrder = require('../../db/book-order');
const snapshots = require('../../db/book-snapshots');

function _err(code) { const e = new Error(code); e.code = code; return e; }

// Alle Seiten-Metas (Top-Pages + rekursiv aus Kapiteln) flach einsammeln.
function _collectMetas(tree) {
  const metas = [];
  for (const p of (tree.topPages || [])) metas.push(p);
  (function walk(chapters) {
    for (const c of (chapters || [])) {
      for (const p of (c.pages || [])) metas.push(p);
      walk(c.subchapters || []);
    }
  })(tree.chapters || []);
  return metas;
}

// Kapitel (inkl. Sub-Kapitel) im node-Tree zaehlen.
function _countChapters(nodes) {
  let n = 0;
  (function walk(list) {
    for (const node of (list || [])) {
      if (node && node.type === 'chapter') { n += 1; walk(node.children); }
    }
  })(nodes);
  return n;
}

// Kompakte Zaehl-Uebersicht des eingefrorenen Analyse-/Lektorat-Stands
// (extras_json). Publikations-Nachweis „so sah der Weltaufbau/das Lektorat zum
// Zeitpunkt der Fassung aus" — ohne die MB-grossen Rohdaten auszuliefern. Nur
// Bloecke mit >0 Zeilen erscheinen. Nimmt das Extras-Objekt oder seinen
// JSON-String. Defekt/leer → null.
function extrasSummary(extras) {
  if (!extras) return null;
  let parsed = extras;
  if (typeof extras === 'string') {
    try { parsed = JSON.parse(extras); } catch { return null; }
  }
  const a = parsed?.analysis || {};
  const len = (x) => (Array.isArray(x) ? x.length : 0);
  const out = {
    figures: len(a.figures),
    locations: len(a.locations),
    scenes: len(a.scenes),
    events: len(a.zeitstrahlEvents),
    worldFacts: len(a.worldFacts),
    continuityIssues: len(a.continuityIssues),
    ideen: len(a.ideen),
    lektoratFindings: len(parsed?.lektorat?.pageChecks),
  };
  const has = Object.values(out).some((n) => n > 0);
  return has ? out : null;
}

// Publikations-Metadaten selbsttragend einfrieren (Titelei/epub_*-Optionen +
// Cover/Autorfoto als base64), damit ein Fassungs-Export den Stand zum Capture-
// Zeitpunkt nutzt statt der Live-book_publication. Nur wenn eine echte Zeile
// existiert (getMeta.created_at) — sonst faellt der Export auf die Live-Defaults.
function _freezePublication(bookId) {
  const bp = require('../../db/book-publication');
  const meta = bp.getMeta(bookId);
  if (!meta || !meta.created_at) return { meta: null, json: null };
  const pub = { meta };
  if (meta.has_cover) {
    const c = bp.getCover(bookId);
    if (c && c.image) pub.cover = { b64: c.image.toString('base64'), mime: c.mime || 'image/jpeg' };
  }
  if (meta.has_author_image) {
    const a = bp.getAuthorImage(bookId);
    if (a && a.image) pub.authorImage = { b64: a.image.toString('base64'), mime: a.mime || 'image/jpeg' };
  }
  return { meta, json: JSON.stringify(pub) };
}

// Wirft typisierte Fehler:
//   NOT_FOUND      — Buch existiert nicht
//   BOOK_EMPTY     — Buch hat keine Seiten
//   CAPTURE_FAILED — Load der Inhalte fehlgeschlagen
// `light: true` (Drift-Check): nur Text/Struktur/Settings + Publikations-TEXT-
// Meta (`publicationMeta`) — ohne Bild-BLOBs, Cover-base64 und Analyse-Extras,
// die beim blossen Vergleichen nur Zeit und Speicher kosten.
async function buildSnapshotPayload(bookId, req, { light = false } = {}) {
  let book, tree;
  try {
    [book, tree] = await Promise.all([
      contentStore.loadBook(bookId, req),
      contentStore.bookTree(bookId, req),
    ]);
  } catch (e) {
    if (e.status === 404) throw _err('NOT_FOUND');
    throw _err('CAPTURE_FAILED');
  }

  const metas = _collectMetas(tree);
  if (!metas.length) throw _err('BOOK_EMPTY');

  let details;
  try {
    details = await contentStore.loadPagesBatch(metas, req, { batchSize: 15, onError: () => null });
  } catch (e) {
    throw _err('CAPTURE_FAILED');
  }
  const htmlById = new Map();
  for (const d of details) if (d && d.id) htmlById.set(d.id, d.html || '');

  // Manuskript-Bild-BLOBs mitziehen, damit eine Fassung selbsttragend bleibt
  // (Export als data:-URI, Restore einer inzwischen geloeschten Seite).
  let imagesByPage = null;
  if (!light) {
    const { collectReferencedImages } = require('../../db/page-images');
    imagesByPage = collectReferencedImages(htmlById, bookId);
  }
  // Order-Tree mitnehmen: nur er kennt das Interleaving (Seite zwischen Kapiteln).
  const orderTree = (() => { try { return bookOrder.getOrder(bookId)?.tree || null; } catch { return null; } })();
  const nodes = treeToNodes(tree, htmlById, imagesByPage, orderTree);
  const settings = (() => { try { return getBookSettings(bookId); } catch { return null; } })();
  const content = buildBookJson({ book, settings, nodes });

  // Stats aus dem inline-HTML (gleiche Normalisierung wie page_stats).
  // `wordsByPage` traegt zusaetzlich den Nenner der Fehlerdichte im Trend
  // (lib/lektorat-metrics.js#words_checked: nur gepruefte Seiten zaehlen).
  let chars = 0; let words = 0;
  const wordsByPage = new Map();
  for (const [id, html] of htmlById) {
    const text = htmlToPlainText(html);
    chars += text.length;
    const w = text ? text.split(/\s+/).filter(Boolean).length : 0;
    words += w;
    wordsByPage.set(Number(id), w);
  }
  const stats = { chars, words, pages: htmlById.size, chapters: _countChapters(nodes) };

  if (light) {
    let publicationMeta = null;
    try {
      const bp = require('../../db/book-publication');
      const meta = bp.getMeta(bookId);
      // Bild-Hashes wie snapshotPublication sie fuer die Fassung liefert → der
      // Drift erkennt ein ausgetauschtes Cover/Autorfoto.
      publicationMeta = meta && meta.created_at ? {
        ...meta,
        cover_hash: meta.has_cover ? imageHash(bp.getCover(bookId)?.image) : null,
        author_image_hash: meta.has_author_image ? imageHash(bp.getAuthorImage(bookId)?.image) : null,
      } : null;
    } catch (e) { logger.warn(`Drift-Publikation fehlgeschlagen (book=${bookId}): ${e.message}`); }
    return { content, publicationMeta, ...stats };
  }

  // Extras (Analyse + Lektorat) synchron einsammeln — reiner DB-Read, kein KI-Call.
  // Aus den eingefrorenen page_checks gleich die verdichtete Fehler-Kennzahl
  // (offen/angenommen/alle je Typ) ableiten → Basis für den Fehlerdichte-Trend
  // über die Fassungen, ohne den extras_json-Blob ausliefern zu müssen.
  let extrasJson = null;
  let extrasSummaryJson = null;
  let lektoratMetrics = null;
  try {
    const extras = collectExtras(bookId, { analysis: true, lektorat: true }, sessionEmail(req)); // 3. Arg = Analyse-Scope, siehe _pickScope
    if (extras && (extras.analysis || extras.lektorat)) {
      extrasJson = JSON.stringify(extras);
      const summary = extrasSummary(extras);
      if (summary) extrasSummaryJson = JSON.stringify(summary);
    }
    const checks = extras?.lektorat?.pageChecks;
    if (Array.isArray(checks) && checks.length) {
      const { computeLektoratMetrics } = require('../../lib/lektorat-metrics');
      lektoratMetrics = JSON.stringify(computeLektoratMetrics(checks, { wordsByPage }));
    }
  } catch (e) {
    logger.warn(`Snapshot-Extras fehlgeschlagen (book=${bookId}): ${e.message}`);
  }

  let publicationJson = null;
  try { publicationJson = _freezePublication(bookId).json; }
  catch (e) { logger.warn(`Snapshot-Publikation fehlgeschlagen (book=${bookId}): ${e.message}`); }

  return { content, extrasJson, extrasSummaryJson, publicationJson, lektoratMetrics, ...stats };
}

// Payload als neue Fassung ablegen. Liefert { id, seq }.
function insertPayload(bookId, payload, { kind = 'manual', label = null, description = null, userEmail = null } = {}) {
  return snapshots.createSnapshot({
    bookId, kind, label, description,
    contentJson: JSON.stringify(payload.content), extrasJson: payload.extrasJson,
    extrasSummary: payload.extrasSummaryJson || null,
    publicationJson: payload.publicationJson, lektoratMetrics: payload.lektoratMetrics,
    chars: payload.chars, words: payload.words, pages: payload.pages, chapters: payload.chapters,
    userEmail,
  });
}

// Haelt die Baseline-Fassung (der Stand, den das Buch zuletzt hatte) bereits
// genau diesen Stand fest? `scope: 'tree'` vergleicht nur den node-Tree (Text,
// Struktur, Namen) — fuer die Auto-Fassung beim Fertig-Markieren, das die
// Settings selbst aendert. `scope: 'state'` vergleicht alles, was ein Restore
// ueberschreibt (Tree, Buch-Kopf samt Settings, Publikation) — fuer die
// Auto-Sicherung: sie ist nur dann ueberfluessig, wenn nichts davon verloren ginge.
function sameAsBaseline(bookId, payload, { scope = 'tree' } = {}) {
  const base = snapshots.getBaselineSnapshot(bookId);
  if (!base) return false;
  try {
    const stored = JSON.parse(base.content_json);
    if (scope === 'tree') return JSON.stringify(stored.tree) === JSON.stringify(payload.content.tree);
    return JSON.stringify(stored) === JSON.stringify(payload.content)
      && (base.publication_json || null) === (payload.publicationJson || null);
  } catch { return false; }
}

// Wiederverwendbarer Capture-Einstieg fuer Auto-Sicherungen aus anderen Routen
// (z.B. „Buch als fertig markiert" in routes/booksettings.js). dedup → ueberspringt,
// wenn die Baseline-Fassung denselben Stand haelt (true = 'tree', sonst die
// sameAsBaseline-Scope). Wirft NICHT — liefert null bei leerem Buch,
// Dedup-Treffer oder Fehler (Aufrufer sind best-effort).
async function captureSnapshot(bookId, req, { kind = 'manual', label = null, description = null, dedup = false, userEmail = null } = {}) {
  let payload;
  try {
    payload = await buildSnapshotPayload(bookId, req);
  } catch (e) {
    if (e.code !== 'BOOK_EMPTY') logger.warn(`Auto-Capture fehlgeschlagen (book=${bookId}): ${e.message}`);
    return null;
  }
  if (dedup && sameAsBaseline(bookId, payload, { scope: dedup === true ? 'tree' : dedup })) return null;
  try {
    return insertPayload(bookId, payload, { kind, label, description, userEmail });
  } catch (e) {
    logger.warn(`Auto-Capture-Insert fehlgeschlagen (book=${bookId}): ${e.message}`);
    return null;
  }
}

module.exports = { buildSnapshotPayload, insertPayload, captureSnapshot, sameAsBaseline, extrasSummary };
