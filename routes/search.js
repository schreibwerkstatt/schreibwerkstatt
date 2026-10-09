'use strict';
// Volltextsuche-API.
//
// GET /search?q=...&kind=page,chapter&book_id=42&limit=50&offset=0
//   - ACL strikt: JOIN gegen book_access via session.user.email.
//   - book_id: viewer-Guard auf das Buch (Cross-Book-Suche unterbunden).
//   - kind: Komma-Liste aus VALID_KINDS (book/chapter/page/figure/location/
//           scene/idea); Default = page,chapter (Spec-Default).
//   - Trigram-Fallback automatisch bei Single-Word-Zero-Hit.
//
// Response: { hits: [{ kind, entity_id, nav_id, book_id, title, snippet, rank }],
//             fallback: boolean }
//   - entity_id: INTEGER-PK der Tabelle (Index-Anker).
//   - nav_id:    ID, mit der die Oberflaeche den Treffer oeffnet — bei
//                figure/location die TEXT-ID (fig_id/loc_id), sonst = entity_id.
//                Siehe lib/search.js#attachNavIds.

const express = require('express');
const { toIntId } = require('../lib/validate');
const { guardBook, sessionEmail } = require('../lib/acl');
const bookAccess = require('../db/book-access');
const searchIndex = require('../lib/search');
const semanticChunks = require('../db/semantic-chunks');
const embed = require('../lib/embed');
const semanticRetrieval = require('../lib/semantic-retrieval');
const { db } = require('../db/connection');
const logger = require('../logger');
const { pageTitle } = require('../db/content-names');
const { setContext } = require('../lib/log-context');

const router = express.Router();

const DEFAULT_KINDS = ['page', 'chapter'];
// Kinds, für die ein Embedding-Index existiert (semantische Suche).
const SEMANTIC_KINDS = ['page', 'scene', 'figure', 'research', 'location', 'fact'];

function _parseKinds(raw) {
  if (raw == null) return DEFAULT_KINDS;
  const s = String(raw).trim();
  if (!s || s === '*' || s === 'all') return Array.from(searchIndex.VALID_KINDS);
  const parts = s.split(',').map(x => x.trim()).filter(Boolean);
  const filtered = parts.filter(k => searchIndex.VALID_KINDS.has(k));
  return filtered.length ? filtered : DEFAULT_KINDS;
}

router.get('/', (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });

  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json({ hits: [], fallback: false });
  if (q.length > 200) return res.status(400).json({ error_code: 'QUERY_TOO_LONG' });

  const bookId = req.query.book_id ? toIntId(req.query.book_id) : null;
  if (req.query.book_id && !bookId) return res.status(400).json({ error_code: 'INVALID_BOOK_ID' });

  if (bookId) {
    if (!guardBook(req, res, bookId, 'viewer')) return;
  }

  const kinds = _parseKinds(req.query.kind);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  let allowedBookIds = null;
  if (!bookId) {
    allowedBookIds = bookAccess.listBookIdsForUser(email).map(r => r.book_id);
    if (!allowedBookIds.length) return res.json({ hits: [], fallback: false });
  }

  try {
    const result = searchIndex.query(q, {
      allowedBookIds, kinds, bookId, limit, offset,
    });
    res.json({
      // nav_id = ID, mit der die Oberflaeche den Treffer oeffnet (siehe
      // lib/search.js#attachNavIds). Nur hier angehaengt, nicht in query():
      // die Server-Konsumenten des Index (Motiv-Scan, Beat-Verankerung,
      // semantische Fusion) navigieren nichts und sollen die Zusatz-Queries
      // nicht bezahlen.
      hits: searchIndex.attachNavIds(result.hits || []),
      fallback: !!result.fallback,
    });
  } catch (e) {
    logger.error(`[search] GET /search failed: ${e.message}`);
    res.status(500).json({ error_code: 'SEARCH_FAILED', detail: e.message });
  }
});

// Semantische Suche (Embedding-basiert, buch-skopiert). Zwei Eingänge:
//   ?q=…                    → Freitext, wird einmal embeddet
//   ?like_kind=…&like_id=…  → „ähnliche Stellen zu dieser Entität" (Seite/Szene/
//                             Figur/Schauplatz/Welt-Fakt/Recherche); nutzt den
//                             bereits indizierten Mittelvektor, KEIN Embedding-
//                             Call, und schliesst die Quelle aus. like_id ist bei
//                             Figur/Schauplatz die TEXT-ID (fig_id/loc_id) oder
//                             der PK; fremde/fehlende Quelle → 404.
// Immer book_id-Pflicht (Vektoren leben pro Buch) + viewer-ACL. Trefferformat
// spiegelt die FTS-Route: { kind, entity_id, nav_id, book_id, chunk_ix, title,
// snippet, score }, dazu `notIndexed` (Index fehlt/unvollständig → Hinweis statt
// „keine Treffer").
// Snippet fliesst im Frontend in einen x-html-Sink (search.html) → server-seitig
// escapen (Hard-Rule „x-html nur mit vorab-escaptem Content"). Kein <mark> nötig
// (semantische Treffer haben keine Wort-Offsets).
function _escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Treffer-/Quell-Lookups der semantischen Suche. Szenen, Figuren, Schauplätze
// und Welt-Fakten sind Analyse-Daten PRO USER (`user_email`): ein Co-Autor sieht
// im selben Buch nur seine eigenen — Treffer wie Quelle werden darum auf
// (book_id, user_email) skopiert. Der Retrieval-Pfad filtert schon vor dem
// topK-Schnitt (Option `user`), sonst kämen nach diesem Filter zu wenige Treffer
// zurück; die Auflösung hier bleibt die zweite Schicht (Titel + Existenz). Recherche ist buch-geteilt, Seiten laufen über
// db/content-names (keine Roh-SQL auf `pages`). Lazy vorbereitet: das Modul wird
// vor dem Migrationslauf geladen.
let _stmts = null;
function _s() {
  if (_stmts) return _stmts;
  const owned = (cols, table) => db.prepare(
    `SELECT id, ${cols} FROM ${table} WHERE id = ? AND book_id = ? AND user_email IS ?`);
  _stmts = {
    scene: owned('titel AS title', 'figure_scenes'),
    figure: owned('name AS title', 'figures'),
    location: owned('name AS title', 'locations'),
    // Welt-Fakten haben keinen Titel — Subjekt + Fakt, gekürzt, sind die Beschriftung.
    fact: owned("TRIM(COALESCE(NULLIF(subjekt,'') || ': ', '') || fakt) AS title", 'world_facts'),
    // Recherche-Schnipsel haben keinen Pflichttitel — der Dateiname des
    // hochgeladenen PDFs ist dann die einzige Beschriftung, die der Treffer hat.
    research: db.prepare(
      "SELECT id, COALESCE(NULLIF(title,''), doc_name) AS title FROM research_items WHERE id = ? AND book_id = ?"),
    figureByPub: db.prepare('SELECT id FROM figures WHERE fig_id = ? AND book_id = ? AND user_email IS ?'),
    locationByPub: db.prepare('SELECT id FROM locations WHERE loc_id = ? AND book_id = ? AND user_email IS ?'),
  };
  return _stmts;
}

const _TITLE_MAX = 120;

// `{ title }` der Entität, wenn sie zu diesem Buch (und bei User-Daten zu diesem
// User) gehört, sonst null. Eine verschobene Seite (anderes Buch) gilt als fremd.
function _ownedEntity(kind, id, bookId, email) {
  if (!id) return null;
  if (kind === 'page') {
    const row = pageTitle(id);
    return row && Number(row.book_id) === bookId ? row : null;
  }
  const st = _s();
  if (kind === 'research') return st.research.get(id, bookId) || null;
  if (!st[kind]) return null;
  return st[kind].get(id, bookId, email) || null;
}

// like_id → INTEGER-PK der Quell-Entität (oder null, wenn sie nicht in diesem
// Buch/bei diesem User liegt). Figuren und Schauplätze adressiert die Oberfläche
// über ihre TEXT-ID (fig_id/loc_id, z.B. „fig_1"); der Index führt den PK. Die
// TEXT-ID gewinnt, weil eine rein numerische fig_id sonst als fremder PK gelesen
// würde; ein ganzzahliger PK funktioniert weiterhin als Fallback.
function _resolveLikeId(kind, rawId, bookId, email) {
  const raw = String(rawId == null ? '' : rawId).trim();
  if (!raw || raw.length > 100) return null;
  const pub = kind === 'figure' ? 'figureByPub' : kind === 'location' ? 'locationByPub' : null;
  if (pub) {
    const row = _s()[pub].get(raw, bookId, email);
    if (row) return row.id;
  }
  const id = toIntId(raw);
  return id && _ownedEntity(kind, id, bookId, email) ? id : null;
}

function _resolveSemanticHits(hits, bookId, email) {
  const out = [];
  for (const h of hits) {
    // Gelöschte, verschobene oder fremde (Co-Autor-)Entität → überspringen.
    const row = _ownedEntity(h.kind, h.entity_id, bookId, email);
    if (!row) continue;
    let title = String(row.title || '');
    if (title.length > _TITLE_MAX) title = title.slice(0, _TITLE_MAX - 1) + '…';
    out.push({
      kind: h.kind, entity_id: h.entity_id, book_id: bookId,
      chunk_ix: h.chunk_ix ?? null,
      title, snippet: _escHtml(String(h.text || '').slice(0, 300)),
      score: Math.round(h.score * 1000) / 1000,
    });
  }
  // Gleiche Aufloesung wie im FTS-Pfad: `semantic_chunks.entity_id` ist bei
  // `figure`/`location` der INTEGER-PK, die Karten kennen nur fig_id/loc_id.
  return searchIndex.attachNavIds(out);
}

router.get('/semantic', async (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  if (!embed.isEnabled()) return res.status(400).json({ error_code: 'EMBED_DISABLED' });

  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!guardBook(req, res, bookId, 'viewer')) return;
  setContext({ book: bookId });

  // Eigene Kind-Liste statt _parseKinds: `fact` ist ein reiner Embedding-Kind
  // (kein FTS-Kind), und ohne kind-Parameter gelten alle indizierten Kinds.
  const rawKinds = String(req.query.kind || '').split(',').map(x => x.trim())
    .filter(k => SEMANTIC_KINDS.includes(k));
  const kinds = rawKinds.length ? rawKinds : SEMANTIC_KINDS;
  const topK = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

  const likeKind = String(req.query.like_kind || '').trim();

  try {
    if (likeKind) {
      if (!SEMANTIC_KINDS.includes(likeKind)) return res.status(400).json({ error_code: 'INVALID_LIKE_KIND' });
      // Quelle MUSS in diesem Buch (und bei User-Daten beim User) liegen, bevor
      // ihr Vektor gelesen wird — sonst liefe die Ähnlichkeitssuche mit dem
      // Vektor einer fremden Entität. Nicht vorhanden und fremd antworten gleich
      // (kein Existenz-Leak).
      const likeId = _resolveLikeId(likeKind, req.query.like_id, bookId, email);
      if (!likeId) return res.status(404).json({ error_code: 'LIKE_ENTITY_NOT_FOUND' });
      // „Ähnliche Stellen zu Entität": Retrieval über den gemittelten Entitäts-
      // Vektor, danach optionales Reranking gegen den Entitäts-Text (siehe
      // lib/semantic-retrieval#similarToEntity). Kein Hybrid — hier gibt es keinen
      // Anfragetext für die FTS-Seite.
      const sim = await semanticRetrieval.similarToEntity(bookId, likeKind, likeId, { kinds, topK, user: email });
      const notIndexed = !!sim.notIndexed || !semanticRetrieval.indexReady(bookId);
      return res.json({ hits: sim.notIndexed ? [] : _resolveSemanticHits(sim.hits, bookId, email), mode: 'semantic', notIndexed });
    }
    const q = (req.query.q || '').toString().trim();
    if (q.length < 2) return res.json({ hits: [], mode: 'semantic' });
    if (q.length > 500) return res.status(400).json({ error_code: 'QUERY_TOO_LONG' });
    // Freitext: Retrieval → Hybrid-Fusion → Reranking (siehe lib/semantic-retrieval).
    // Mehrere getrennte Passagen je Entität: ein langer Abschnitt (ein Kapitel am
    // Stück) soll nicht nur seine eine beste Stelle zeigen. Jeder Treffer trägt
    // chunk_ix + Snippet der eigenen Passage.
    const raw = await semanticRetrieval.semanticQuery(bookId, q, {
      kinds, topK, user: email, perEntity: semanticRetrieval.PASSAGES_PER_ENTITY,
    });
    res.json({
      hits: _resolveSemanticHits(raw, bookId, email), mode: 'semantic',
      notIndexed: !semanticRetrieval.indexReady(bookId),
    });
  } catch (e) {
    logger.error(`[search] GET /search/semantic failed: ${e.message}`);
    res.status(503).json({ error_code: 'EMBED_UNAVAILABLE' });
  }
});

router.get('/semantic/status', (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  if (!embed.isEnabled()) return res.json({ enabled: false });

  const bookId = toIntId(req.query.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  if (!guardBook(req, res, bookId, 'viewer')) return;

  const { model } = embed.getConfig();
  try {
    // staleCount user-skopiert: Analyse-Änderungen eines Co-Autors betreffen
    // nicht, was dieser User findet (siehe indexStatus).
    res.json({ enabled: true, ...semanticChunks.indexStatus(bookId, model, email) });
  } catch (e) {
    logger.error(`[search] GET /search/semantic/status failed: ${e.message}`);
    res.status(500).json({ error_code: 'STATUS_FAILED', detail: e.message });
  }
});

// Semantische Suche über die Quellen-PDFs des Users (Pool-Scope). Pendant zu
// /search/semantic, aber **user-skopiert**: keine book_id, keine Buch-ACL —
// der User durchsucht seine eigene Bibliothek. Trefferformat:
//   { source_id, title, citekey, snippet, score }
// Der Snippet ist ROHTEXT und wird bewusst NICHT escapt: er landet in einem
// `x-text`-Sink (public/partials/sources-lib-search.html), der selbst escapt —
// ein zweiter Durchgang zeigte dem Leser sichtbare `&amp;`/`&lt;` im Zitat.
// Anders als /search/semantic, dessen Snippet ein <mark>-Highlight traegt und
// darum ueber x-html geht. Wer den Sink hier auf x-html umstellt, muss das
// Escaping mit umstellen.
router.get('/sources-semantic', async (req, res) => {
  const email = sessionEmail(req);
  if (!email) return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
  if (!embed.isEnabled()) return res.status(400).json({ error_code: 'EMBED_DISABLED' });

  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json({ hits: [], mode: 'sources-semantic' });
  if (q.length > 500) return res.status(400).json({ error_code: 'QUERY_TOO_LONG' });

  const topK = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

  try {
    const raw = await semanticRetrieval.semanticSourceQuery(email, q, { topK });
    const hits = raw.map(h => ({
      source_id: h.source_id,
      title: h.title || '', citekey: h.citekey || '',
      snippet: String(h.text || '').slice(0, 300),
      score: Math.round(h.score * 1000) / 1000,
    }));
    res.json({ hits, mode: 'sources-semantic' });
  } catch (e) {
    logger.error(`[search] GET /search/sources-semantic failed: ${e.message}`);
    res.status(503).json({ error_code: 'EMBED_UNAVAILABLE', detail: e.message });
  }
});

module.exports = router;
