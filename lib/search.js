'use strict';
// SQLite-FTS5-Volltextsuche.
//
// Single Entry Point fuer Index-Mutationen + Query. Konsumenten rufen
// `upsertPage(pageId)` / `upsertChapter(chapterId)` / `upsertBookMeta(bookId)` /
// `upsertFigure(figureId)` / `upsertLocation(locId)` / `upsertScene(sceneId)` /
// `upsertIdea(ideaId)` auf — die Funktion liest die aktuelle Row aus der DB
// und schreibt sie in beide FTS5-Tabellen (Haupt-Index + Title-Trigram).
//
// Body-Felder werden mit dem identischen Tag-zu-Space-Replacement wie
// routes/sync.js (htmlToText) / db/page-revisions.js normalisiert
// (Pflicht-Konsistenz, sonst Drift zu page_stats).
//
// Failures werden als warn geloggt, niemals geworfen — Index-Schreiber sind
// Side-Effects der eigentlichen Mutation; ein Search-Fehler darf den Save
// nicht abbrechen.

const { db } = require('../db/connection');
const { NOW_ISO_SQL } = require('../db/now');
const logger = require('../logger');
const { htmlToPlainText } = require('./html-text');

const htmlToText = htmlToPlainText;

const VALID_KINDS = new Set([
  'book', 'chapter', 'page', 'figure', 'location', 'scene', 'idea', 'song', 'research',
]);

// Daten PRO USER (`user_email` in der Quelltabelle): ein Co-Autor sieht im
// selben Buch nur seine eigenen. query() filtert diese Arten mit Option `user`.
// Recherche ist buch-geteilt, Buch/Kapitel/Abschnitt sowieso.
const USER_KINDS = new Set(['figure', 'location', 'scene', 'idea', 'song']);

// Die rowid leitet sich aus (kind, entity_id) ab: Upsert und Remove loeschen per
// rowid-Lookup statt per Vollscan ueber die UNINDEXED-Spalten (FTS5 hat auf
// ihnen keinen Index). Der Code einer Art ist eine Persistenz-Konstante —
// aendern nur zusammen mit einem Reindex.
const _KIND_CODE = {
  book: 1, chapter: 2, page: 3, figure: 4, location: 5, scene: 6, idea: 7, song: 8, research: 9,
};
const _ROWID_SPAN = 2 ** 40;
function _rowid(kind, entityId) {
  const id = Number(entityId);
  if (!Number.isInteger(id) || id < 0 || id >= _ROWID_SPAN) throw new Error(`searchIndex: invalid entity_id "${entityId}"`);
  return _KIND_CODE[kind] * _ROWID_SPAN + id;
}

const _delIndex = db.prepare('DELETE FROM search_index WHERE rowid = ?');
const _delTrigram = db.prepare('DELETE FROM search_trigram WHERE rowid = ?');
const _insIndex = db.prepare(`
  INSERT INTO search_index (rowid, kind, entity_id, book_id, user_email, title, body)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const _insTrigram = db.prepare(`
  INSERT INTO search_trigram (rowid, kind, entity_id, book_id, user_email, title)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// Statement-Cache: jedes SQL einmal vorbereiten statt pro Aufruf (reindexAll
// ruft die _upsert*-Helfer pro Entitaet). Lazy, damit der Modul-Import nicht
// an Tabellen haengt, die erst eine spaetere Migration anlegt.
const _stmtCache = new Map();
function _q(sql) {
  let st = _stmtCache.get(sql);
  if (!st) { st = db.prepare(sql); _stmtCache.set(sql, st); }
  return st;
}

// DELETE + INSERT in einer Transaktion: ein Fehler zwischen beiden liesse den
// Eintrag sonst verschwunden statt aktualisiert zurueck. Innerhalb einer
// aeusseren Transaktion (reindexAll) wird daraus ein Savepoint.
const _writeRow = db.transaction(function _writeRowTx(kind, entityId, bookId, userEmail, title, body) {
  if (!VALID_KINDS.has(kind)) throw new Error(`searchIndex: invalid kind "${kind}"`);
  const rowid = _rowid(kind, entityId);
  _delIndex.run(rowid);
  _delTrigram.run(rowid);
  const cleanTitle = (title || '').toString().trim();
  const cleanBody = (body || '').toString();
  if (!cleanTitle && !cleanBody) return;
  const user = USER_KINDS.has(kind) ? (userEmail || null) : null;
  _insIndex.run(rowid, kind, entityId, bookId || null, user, cleanTitle, cleanBody);
  if (cleanTitle) {
    _insTrigram.run(rowid, kind, entityId, bookId || null, user, cleanTitle);
  }
});

function _safe(fn, label) {
  return function (...args) {
    try { return fn(...args); }
    catch (e) {
      logger.warn(`searchIndex.${label}(${args.join(',')}) fehlgeschlagen: ${e.message}`);
      return null;
    }
  };
}

function remove(kind, entityId) {
  if (!VALID_KINDS.has(kind)) return;
  const rowid = _rowid(kind, entityId);
  _delIndex.run(rowid);
  _delTrigram.run(rowid);
}

function _upsertPage(pageId) {
  const r = _q(
    'SELECT page_id, book_id, page_name, body_html FROM pages WHERE page_id = ?'
  ).get(pageId);
  if (!r) { remove('page', pageId); return; }
  _writeRow('page', pageId, r.book_id, null, r.page_name || '', htmlToText(r.body_html));
}

function _upsertChapter(chapterId) {
  const r = _q(
    'SELECT chapter_id, book_id, chapter_name FROM chapters WHERE chapter_id = ?'
  ).get(chapterId);
  if (!r) { remove('chapter', chapterId); return; }
  _writeRow('chapter', chapterId, r.book_id, null, r.chapter_name || '', '');
}

function _upsertBookMeta(bookId) {
  const r = _q(
    `SELECT b.book_id, b.name, bp.description
       FROM books b LEFT JOIN book_publication bp ON bp.book_id = b.book_id
      WHERE b.book_id = ?`
  ).get(bookId);
  if (!r) { remove('book', bookId); return; }
  _writeRow('book', bookId, bookId, null, r.name || '', htmlToText(r.description));
}

function _upsertFigure(figureId) {
  const r = _q(
    'SELECT id, book_id, user_email, name, beschreibung FROM figures WHERE id = ?'
  ).get(figureId);
  if (!r) { remove('figure', figureId); return; }
  _writeRow('figure', figureId, r.book_id, r.user_email, r.name || '', r.beschreibung || '');
}

function _upsertLocation(locId) {
  const r = _q(
    'SELECT id, book_id, user_email, name, beschreibung FROM locations WHERE id = ?'
  ).get(locId);
  if (!r) { remove('location', locId); return; }
  _writeRow('location', locId, r.book_id, r.user_email, r.name || '', r.beschreibung || '');
}

function _upsertSong(songId) {
  const r = _q(
    'SELECT id, book_id, user_email, titel, interpret, beschreibung FROM songs WHERE id = ?'
  ).get(songId);
  if (!r) { remove('song', songId); return; }
  const title = [r.titel, r.interpret].filter(Boolean).join(' — ');
  _writeRow('song', songId, r.book_id, r.user_email, title, r.beschreibung || '');
}

function _upsertScene(sceneId) {
  const r = _q(
    'SELECT id, book_id, user_email, titel, kommentar FROM figure_scenes WHERE id = ?'
  ).get(sceneId);
  if (!r) { remove('scene', sceneId); return; }
  _writeRow('scene', sceneId, r.book_id, r.user_email, r.titel || '', r.kommentar || '');
}

function _upsertIdea(ideaId) {
  const r = _q(
    'SELECT id, book_id, user_email, content FROM ideen WHERE id = ?'
  ).get(ideaId);
  if (!r) { remove('idea', ideaId); return; }
  // ideen.content ist Plain-Text. Erste Zeile als Titel, damit Trigram-Index +
  // bm25-title-Boost greifen.
  const text = (r.content || '').toString();
  const firstLine = text.split('\n')[0] || '';
  const title = firstLine.slice(0, 120);
  _writeRow('idea', ideaId, r.book_id, r.user_email, title, text);
}

function _upsertResearch(itemId) {
  const r = _q(
    'SELECT id, book_id, kind, title, body, source, doc_name, doc_text FROM research_items WHERE id = ?'
  ).get(itemId);
  if (!r) { remove('research', itemId); return; }
  // URLs (mit optionalem Label) als eigene Kind-Tabelle indizieren.
  const urlText = _q('SELECT url, label FROM research_item_urls WHERE item_id = ? ORDER BY position, id')
    .all(itemId).map(u => [u.label, u.url].filter(Boolean).join(' ')).join('\n');
  // Plain-Text-Felder inkl. extrahiertem Dokument-Text. Titel-Fallback: erste
  // Body-Zeile bzw. Dokumentname (fuer Trigram + bm25-Boost).
  const body = [r.body, urlText, r.source, r.doc_name, r.doc_text].filter(Boolean).join('\n');
  const firstLine = (r.body || '').toString().split('\n')[0] || '';
  const title = (r.title && r.title.trim())
    ? r.title.trim()
    : (firstLine || r.doc_name || '').slice(0, 120);
  _writeRow('research', itemId, r.book_id, null, title, body);
}

// Buch-Loeschung: FTS5 unterstuetzt keine FKs/CASCADE — Caller ruft das nach
// books-DELETE.
function _removeAllForBook(bookId) {
  _q('DELETE FROM search_index WHERE book_id = ?').run(bookId);
  _q('DELETE FROM search_trigram WHERE book_id = ?').run(bookId);
}

// figures/locations/scenes werden in saveFigurenToDb/saveOrteToDb/
// saveSzenenAndEvents als Full-Replace pro Buch persistiert. Identische
// Strategie im Index: vor dem Re-Upsert alle Eintraege dieser Kind/Buch-
// Kombination droppen.
function _removeKindForBook(kind, bookId) {
  if (!VALID_KINDS.has(kind)) return;
  _q('DELETE FROM search_index WHERE kind = ? AND book_id = ?').run(kind, bookId);
  _q('DELETE FROM search_trigram WHERE kind = ? AND book_id = ?').run(kind, bookId);
}

function _setMeta(key, value) {
  _q(`
    INSERT INTO search_meta (key, value, updated_at)
    VALUES (?, ?, ${NOW_ISO_SQL})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value);
}

function _getMeta(key) {
  const r = _q('SELECT value FROM search_meta WHERE key = ?').get(key);
  return r?.value ?? null;
}

// Eine Transaktion ueber den ganzen Neuaufbau: bei tausenden Entitaeten sonst
// ein fsync pro Zeile, und eine abgebrochene Runde hinterliesse einen halb
// geleerten Index.
function reindexAll() {
  return db.transaction(_reindexAllTx)();
}

function _reindexAllTx() {
  const t0 = Date.now();
  _q('DELETE FROM search_index').run();
  _q('DELETE FROM search_trigram').run();
  const counts = { book: 0, chapter: 0, page: 0, figure: 0, location: 0, scene: 0, idea: 0, song: 0, research: 0 };
  for (const r of _q('SELECT book_id FROM books').all()) { _upsertBookMeta(r.book_id); counts.book++; }
  for (const r of _q('SELECT chapter_id FROM chapters').all()) { _upsertChapter(r.chapter_id); counts.chapter++; }
  for (const r of _q('SELECT page_id FROM pages').all()) { _upsertPage(r.page_id); counts.page++; }
  for (const r of _q('SELECT id FROM figures').all()) { _upsertFigure(r.id); counts.figure++; }
  for (const r of _q('SELECT id FROM locations').all()) { _upsertLocation(r.id); counts.location++; }
  for (const r of _q('SELECT id FROM figure_scenes').all()) { _upsertScene(r.id); counts.scene++; }
  for (const r of _q('SELECT id FROM ideen').all()) { _upsertIdea(r.id); counts.idea++; }
  for (const r of _q('SELECT id FROM songs').all()) { _upsertSong(r.id); counts.song++; }
  for (const r of _q('SELECT id FROM research_items').all()) { _upsertResearch(r.id); counts.research++; }
  _setMeta('reindex_required', '0');
  _setMeta('last_reindex', new Date().toISOString());
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  logger.info(`[search] Reindex abgeschlossen in ${Date.now() - t0}ms: ${total} Eintraege (${JSON.stringify(counts)}).`);
  return counts;
}

function reindexIfNeeded() {
  if (_getMeta('reindex_required') === '1') {
    try { reindexAll(); }
    catch (e) { logger.error(`[search] Initial-Reindex fehlgeschlagen: ${e.message}`); }
  }
}

function optimize() {
  try {
    _q("INSERT INTO search_index(search_index) VALUES('optimize')").run();
    _q("INSERT INTO search_trigram(search_trigram) VALUES('optimize')").run();
    _setMeta('last_optimize', new Date().toISOString());
  } catch (e) {
    logger.warn(`[search] optimize fehlgeschlagen: ${e.message}`);
  }
}

// Query-Parser (Phrasen, Ausschluss, Auto-Prefix, ß/ss): lib/search/match-query.js.
const { buildMatchQuery, NON_WORD: _NON_WORD } = require('./search/match-query');

const _HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function _escHtml(s) { return String(s).replace(/[&<>"']/g, (c) => _HTML_ESC[c]); }
function _escSnippet(s, openSentinel, closeSentinel) {
  // HTML-escape User-Content, dann Sentinel-Marker zu `<mark>`-Tags ersetzen.
  // Reihenfolge zwingend: erst escape (sonst werden injizierte `<mark>` mit
  // escaped), dann Sentinel-Replace.
  const escaped = _escHtml(s);
  const openRe = new RegExp(openSentinel, 'g');
  const closeRe = new RegExp(closeSentinel, 'g');
  return escaped.replace(openRe, '<mark>').replace(closeRe, '</mark>');
}

// Seiten-Treffer mit dem Kapitelnamen anreichern (pages.chapter_id →
// chapters.chapter_name), damit die UI bei mehrseitigen Kapiteln zeigt, zu
// welchem Kapitel eine Seite gehoert. Display-Wert per JOIN zur Lesezeit,
// kein Snapshot. Mutiert die Rows in-place.
function _enrichPageChapters(rows) {
  const pageIds = rows.filter(r => r.kind === 'page').map(r => r.entity_id);
  if (!pageIds.length) return;
  const placeholders = pageIds.map(() => '?').join(',');
  let chRows;
  try {
    chRows = db.prepare(`
      SELECT p.page_id, c.chapter_name
        FROM pages p
        JOIN chapters c ON c.chapter_id = p.chapter_id
       WHERE p.page_id IN (${placeholders})
    `).all(...pageIds);
  } catch (e) {
    logger.warn(`[search] Kapitel-Anreicherung fehlgeschlagen: ${e.message}`);
    return;
  }
  const map = new Map(chRows.map(r => [r.page_id, r.chapter_name]));
  for (const r of rows) {
    if (r.kind === 'page' && map.has(r.entity_id)) r.chapter = map.get(r.entity_id);
  }
}

// Treffer mit der ID anreichern, unter der die OBERFLAECHE die Entitaet
// adressiert (`nav_id`). Der Index fuehrt in `entity_id` durchgehend den
// INTEGER-PK der Tabelle — daran haengen alle Server-Konsumenten (Motiv-Scan,
// Beat-Verankerung, semantische Fusion) und der FK-Bezug.
//
// Figuren und Schauplaetze fuehren nach aussen aber ihre TEXT-ID
// (`figures.fig_id` / `locations.loc_id`): die Katalog-Listen (`GET /figures`,
// `GET /locations`) liefern sie als `id`, die Karten vergleichen damit
// (`selectedOrtId === o.id`) und der Deep-Link-Hash traegt sie. Ohne diese
// Aufloesung oeffnet ein Klick auf einen Volltext-Treffer zwar die Karte und
// schreibt eine plausible URL, findet die Zeile dort aber nie.
//
// Alle uebrigen Arten (page/chapter/book/scene/idea/song/research) fuehren ihren
// PK oeffentlich — dort ist `nav_id` schlicht die `entity_id`. Mutiert in-place.
function attachNavIds(rows) {
  for (const r of rows) r.nav_id = r.entity_id;
  const PUBLIC_ID_COLS = { figure: ['figures', 'fig_id'], location: ['locations', 'loc_id'] };
  for (const [kind, [table, col]] of Object.entries(PUBLIC_ID_COLS)) {
    const ids = rows.filter(r => r.kind === kind).map(r => r.entity_id);
    if (!ids.length) continue;
    let idRows;
    try {
      idRows = db.prepare(
        `SELECT id, ${col} AS pub FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`
      ).all(...ids);
    } catch (e) {
      logger.warn(`[search] nav_id-Aufloesung fehlgeschlagen (${kind}): ${e.message}`);
      continue;
    }
    const map = new Map(idRows.map(r => [r.id, r.pub]));
    for (const r of rows) {
      if (r.kind === kind && map.get(r.entity_id)) r.nav_id = map.get(r.entity_id);
    }
  }
  return rows;
}

function query(input, opts = {}) {
  const {
    allowedBookIds = null,
    kinds = null,
    bookId = null,
    limit = 50,
    offset = 0,
    anyTerms = false,
    // E-Mail des Lesers: Arten mit Daten pro User (USER_KINDS) nur aus seinem
    // Bestand. Ohne Option ungefiltert — Server-Konsumenten, die selbst skopieren.
    user = undefined,
  } = opts;
  const match = buildMatchQuery(input, { anyTerms });
  if (!match) return { hits: [], fallback: false, more: false };
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

  const filter = _scopeFilter({ kinds, bookId, allowedBookIds, user });
  if (!filter) return { hits: [], fallback: false, more: false };
  const whereParts = ['search_index MATCH ?', ...filter.where];
  const args = [match, ...filter.args];

  // Sentinel-Marker statt direkter <mark>-Tags, damit `body`-Inhalt mit
  // rohen HTML-Sonderzeichen (z.B. dekodierte Titel/Figurennamen) sicher
  // escaped werden kann, bevor das Frontend `snippet` per x-html rendert.
  const SNIP_OPEN = '';
  const SNIP_CLOSE = '';
  const sql = `
    SELECT kind, entity_id, book_id, title,
           snippet(search_index, 5, '${SNIP_OPEN}', '${SNIP_CLOSE}', '...', 12) AS snippet,
           bm25(search_index, 5.0, 1.0) AS rank
      FROM search_index
     WHERE ${whereParts.join(' AND ')}
     ORDER BY rank
     LIMIT ? OFFSET ?
  `;
  // Eine Zeile mehr holen: zeigt, ob hinter dieser Seite weitere Treffer liegen.
  args.push(safeLimit + 1, safeOffset);
  let rows;
  try {
    rows = db.prepare(sql).all(...args);
  } catch (e) {
    logger.warn(`[search] FTS-Query fehlgeschlagen ("${input}"): ${e.message}`);
    return { hits: [], fallback: false, more: false };
  }
  const more = rows.length > safeLimit;
  if (more) rows = rows.slice(0, safeLimit);
  for (const r of rows) {
    if (typeof r.snippet === 'string') r.snippet = _escSnippet(r.snippet, SNIP_OPEN, SNIP_CLOSE);
  }
  if (rows.length) { _enrichPageChapters(rows); return { hits: rows, fallback: false, more }; }

  // Single-Word-Zero-Hit-Fallback: Trigram auf Titel. Nur auf der ersten Seite:
  // eine leere Folgeseite heisst «keine weiteren Treffer», nicht «nichts gefunden».
  if (safeOffset > 0) return { hits: [], fallback: false, more: false };
  const words = (input || '').trim().split(/\s+/).filter(Boolean);
  if (words.length !== 1) return { hits: [], fallback: false, more: false };
  // Bindestriche/Unterstriche raus: im FTS5-MATCH ist `-` der NOT-Operator, ein
  // Term wie "A-L-E-X" bricht sonst die Query ("no such column: L"). Der
  // Trigram-Index matcht ohnehin Substrings; als Phrase gequotet bleibt der
  // Rest-Term literal.
  const single = words[0].replace(_NON_WORD, '').replace(/[-_]/g, '');
  if (single.length < 3) return { hits: [], fallback: false, more: false };

  const tWhere = ['search_trigram MATCH ?', ...filter.where];
  const tArgs = ['"' + single + '"', ...filter.args];
  const tSql = `
    SELECT kind, entity_id, book_id, title,
           '' AS snippet,
           0.0 AS rank
      FROM search_trigram
     WHERE ${tWhere.join(' AND ')}
     LIMIT ?
  `;
  tArgs.push(safeLimit);
  let tRows;
  try { tRows = db.prepare(tSql).all(...tArgs); }
  catch (e) {
    logger.warn(`[search] Trigram-Fallback fehlgeschlagen ("${input}"): ${e.message}`);
    return { hits: [], fallback: false, more: false };
  }
  _enrichPageChapters(tRows);
  return { hits: tRows, fallback: true, more: false };
}

// WHERE-Teile fuer Art, Buch und User — gleich fuer Haupt-Index und Trigram
// (beide fuehren dieselben UNINDEXED-Spalten). null = garantiert leer.
function _scopeFilter({ kinds, bookId, allowedBookIds, user }) {
  const where = [];
  const args = [];
  let effKinds = null;
  if (Array.isArray(kinds) && kinds.length) {
    effKinds = kinds.filter(k => VALID_KINDS.has(k));
    if (!effKinds.length) return null;
    where.push(`kind IN (${effKinds.map(() => '?').join(',')})`);
    args.push(...effKinds);
  }
  if (bookId) {
    where.push('book_id = ?');
    args.push(bookId);
  } else if (Array.isArray(allowedBookIds)) {
    if (!allowedBookIds.length) return null;
    where.push(`book_id IN (${allowedBookIds.map(() => '?').join(',')})`);
    args.push(...allowedBookIds);
  }
  if (user !== undefined) {
    const userKinds = [...USER_KINDS].filter(k => !effKinds || effKinds.includes(k));
    if (userKinds.length) {
      where.push(`(kind NOT IN (${userKinds.map(() => '?').join(',')}) OR user_email IS ?)`);
      args.push(...userKinds, user ?? null);
    }
  }
  return { where, args };
}

// Anzahl indizierter Entitäten eines Buches (optional auf kinds gefiltert). Billiger
// COUNT über den abgeleiteten FTS-Index — dient dem Motiv-Scan zum buchgrössen-
// abhängigen Skalieren seines Fundstellen-Caps (TOP_K), ohne Buchinhalt zu laden.
function countEntities(bookId, kinds = null) {
  if (!bookId) return 0;
  const parts = ['book_id = ?'];
  const args = [bookId];
  if (Array.isArray(kinds) && kinds.length) {
    const filtered = kinds.filter(k => VALID_KINDS.has(k));
    if (!filtered.length) return 0;
    parts.push(`kind IN (${filtered.map(() => '?').join(',')})`);
    args.push(...filtered);
  }
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM search_index WHERE ${parts.join(' AND ')}`).get(...args)?.n || 0;
  } catch (e) {
    logger.warn(`[search] countEntities fehlgeschlagen (book=${bookId}): ${e.message}`);
    return 0;
  }
}

module.exports = {
  upsertPage:     _safe(_upsertPage,     'upsertPage'),
  upsertChapter:  _safe(_upsertChapter,  'upsertChapter'),
  upsertBookMeta: _safe(_upsertBookMeta, 'upsertBookMeta'),
  upsertFigure:   _safe(_upsertFigure,   'upsertFigure'),
  upsertLocation: _safe(_upsertLocation, 'upsertLocation'),
  upsertScene:    _safe(_upsertScene,    'upsertScene'),
  upsertIdea:     _safe(_upsertIdea,     'upsertIdea'),
  upsertSong:     _safe(_upsertSong,     'upsertSong'),
  upsertResearch: _safe(_upsertResearch, 'upsertResearch'),
  remove: _safe(remove, 'remove'),
  removeAllForBook: _safe(_removeAllForBook, 'removeAllForBook'),
  removeKindForBook: _safe(_removeKindForBook, 'removeKindForBook'),
  reindexAll,
  reindexIfNeeded,
  optimize,
  query,
  attachNavIds,
  countEntities,
  htmlToText,
  buildMatchQuery,
  VALID_KINDS,
  USER_KINDS,
};
