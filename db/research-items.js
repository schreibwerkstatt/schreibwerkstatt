'use strict';
// Item-Modell des Recherche-Boards: Anlegen, Kind-Tabellen (URLs/Tags) und die
// Ausgabeform eines Fundstuecks samt Relationen.
//
// Warum als eigenes Modul und nicht in routes/research.js: seit der Browser-
// Erweiterung gibt es einen ZWEITEN Eintrittspunkt (routes/capture.js), der
// Fundstuecke anlegt. Ein zweiter Schreibpfad mit eigener Reihenfolge waere die
// klassische Drift-Stelle — ein Aufrufer vergisst `searchIndex.upsertResearch`
// und das Fundstueck ist unauffindbar, ein anderer vergisst die Tags. Darum
// liegt die Schreibsequenz hier einmal und wird von beiden Routen aufgerufen.
//
// `research_items` ist buchweit GETEILT: `user_email` ist Ersteller-Attribution,
// kein Sichtbarkeits-Scope. Die Zugriffsregeln liegen in den Routen (Buch-ACL).

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');
const { normalizeUrls, normalizeTags, RESEARCH_KINDS, normalizeTitleForMatch, TITLE_MATCH_MIN } = require('../lib/research-validate');
const { normalizeUrl } = require('../lib/url-normalize');
const { MAX_TEXT_CHARS } = require('../lib/pdf-extract');
const searchIndex = require('../lib/search');
const { findingsByItem, chapterPlace } = require('./research-findings');
const { activeFigureSql } = require('./figures/active');

// target_kind → { col, table, pk, nameCol, orderCol, refCol } für Validierung,
// Display-JOIN und Sortierung „nach verknüpfter Entität". orderCol ist die Spalte,
// nach der die Entität in ihrer eigenen Ansicht geordnet ist (Buch-Reihenfolge).
// refCol: öffentliche Kennung, unter der das Frontend die Entität kennt
// (Katalog figurenById/orteById, Deep-Link) — die Link-Spalte hält die INTEGER-PK.
//
// Prototypfrei: `target_kind` kommt aus Query/Body. Ein Schluessel wie
// `constructor` oder `__proto__` fiele sonst in den Prototyp und landete als
// `undefined`-Spalte im SQL (500 statt 400). Zugriff von aussen nur ueber
// `linkTarget(kind)`.
const LINK_TARGETS = Object.freeze(Object.assign(Object.create(null), {
  chapter:  { col: 'chapter_id',  table: 'chapters',      pk: 'chapter_id', nameCol: 'chapter_name', orderCol: 'position' },
  page:     { col: 'page_id',     table: 'pages',         pk: 'page_id',    nameCol: 'page_name',    orderCol: 'position' },
  figure:   { col: 'figure_id',   table: 'figures',       pk: 'id',         nameCol: 'name',         orderCol: 'sort_order', refCol: 'fig_id' },
  location: { col: 'location_id', table: 'locations',     pk: 'id',         nameCol: 'name',         orderCol: 'sort_order', refCol: 'loc_id' },
  scene:    { col: 'scene_id',    table: 'figure_scenes', pk: 'id',         nameCol: 'titel',        orderCol: 'sort_order' },
  beat:     { col: 'beat_id',     table: 'plot_beats',    pk: 'id',         nameCol: 'titel',        orderCol: 'sort_order' },
  thread:   { col: 'thread_id',   table: 'plot_threads',  pk: 'id',         nameCol: 'name',         orderCol: 'position' },
}));

/** Deskriptor eines Verknuepfungs-Ziels oder null (unbekannt, kein String,
 *  Prototyp-Schluessel). Der EINE Zugang zu LINK_TARGETS mit fremdem Schluessel. */
function linkTarget(kind) {
  return typeof kind === 'string' && Object.hasOwn(LINK_TARGETS, kind) ? LINK_TARGETS[kind] : null;
}

// Tags + URLs + Links für eine Menge Items nachladen und nach item_id gruppieren.
function attachRelations(items) {
  if (!items.length) return items;
  const ids = items.map(i => i.id);
  const ph = ids.map(() => '?').join(',');

  const tagRows = db.prepare(
    `SELECT item_id, tag FROM research_item_tags WHERE item_id IN (${ph}) ORDER BY tag`
  ).all(...ids);
  const tagsByItem = new Map();
  for (const r of tagRows) {
    if (!tagsByItem.has(r.item_id)) tagsByItem.set(r.item_id, []);
    tagsByItem.get(r.item_id).push(r.tag);
  }

  const urlRows = db.prepare(
    `SELECT id AS url_id, item_id, url, label, checked_at, check_ok, check_code, check_error
       FROM research_item_urls
      WHERE item_id IN (${ph}) ORDER BY item_id, position, id`
  ).all(...ids);
  const urlsByItem = new Map();
  for (const r of urlRows) {
    if (!urlsByItem.has(r.item_id)) urlsByItem.set(r.item_id, []);
    urlsByItem.get(r.item_id).push({
      url_id: r.url_id, url: r.url, label: r.label || '',
      ...(r.checked_at ? { checked_at: r.checked_at, check_ok: r.check_ok === 1, check_code: r.check_code, check_error: r.check_error } : {}),
    });
  }

  // Links inkl. Display-Label per target_kind-spezifischem JOIN (ein Pass je Kind).
  const linksByItem = new Map();
  for (const [kind, t] of Object.entries(LINK_TARGETS)) {
    const rows = db.prepare(
      `SELECT l.id AS link_id, l.item_id, l.${t.col} AS target_id, e.${t.nameCol} AS label${t.refCol ? `, e.${t.refCol} AS ref_id` : ''}
         FROM research_item_links l
         JOIN ${t.table} e ON e.${t.pk} = l.${t.col}
        WHERE l.item_id IN (${ph}) AND l.target_kind = ?`
    ).all(...ids, kind);
    for (const r of rows) {
      if (!linksByItem.has(r.item_id)) linksByItem.set(r.item_id, []);
      linksByItem.get(r.item_id).push({
        link_id: r.link_id, target_kind: kind, target_id: r.target_id, label: r.label || '',
        ...(r.ref_id ? { ref_id: r.ref_id } : {}),
      });
    }
  }

  // Befunde des Recherche-Abgleichs (db/research-findings.js).
  const findings = findingsByItem(ids);

  for (const it of items) {
    it.findings = findings.get(it.id) || [];
    it.tags = tagsByItem.get(it.id) || [];
    it.urls = urlsByItem.get(it.id) || [];
    it.links = linksByItem.get(it.id) || [];
    it.has_image = !!it.image_mime;
    it.has_doc = !!it.doc_mime;
    // Der Extraktor deckelt den Volltext (lib/pdf-extract.js#MAX_TEXT_CHARS);
    // ohne dieses Flag verschwindet der Rest lautlos aus Suche und Index.
    it.doc_truncated = (it.doc_chars ?? 0) >= MAX_TEXT_CHARS;
    delete it.image_mime;
    delete it.doc_mime;
  }
  return items;
}

/** Ausgabeform eines Fundstuecks (ohne BLOBs, mit Relationen). */
// Status-Zuschreibung fuer die Ausgabe: wer hat den Status gesetzt (Anzeigename
// zur Lesezeit per Subselect, keine Snapshot-Spalte). Geteilt von emitItem und
// der Listen-Route, damit beide dieselbe Form liefern.
const STATUS_SELECT_SQL = `ri.status_at, ri.status_by,
            (SELECT display_name FROM app_users au WHERE au.email = ri.status_by) AS status_by_name`;

function emitItem(id) {
  const row = db.prepare(
    `SELECT ri.id, ri.book_id, ri.user_email, ri.kind, ri.title, ri.body, ri.source, ri.image_mime,
            ri.doc_mime, ri.doc_name, ri.doc_pages, ri.doc_chars, ri.status, ri.pinned, ri.archived,
            ri.created_at, ri.updated_at, ${STATUS_SELECT_SQL}
       FROM research_items ri WHERE ri.id = ?`
  ).get(id);
  if (!row) return null;
  attachRelations([row]);
  return row;
}

// urls → geordnete Kind-Tabelle. Normalisierung (http(s)-only, Dedup, Cap, Label)
// kommt aus lib/research-validate (geteilt mit dem Chat-Vorschlag).
//
// Das Ergebnis der Link-Pruefung haengt an der URL, nicht an der Zeile: bleibt
// eine URL beim Bearbeiten stehen, behaelt sie ihren Pruefstand.
function replaceUrls(itemId, urls) {
  const prevChecks = new Map(db.prepare(
    'SELECT url, checked_at, check_ok, check_code, check_error FROM research_item_urls WHERE item_id = ?'
  ).all(itemId).map(r => [r.url, r]));
  db.prepare('DELETE FROM research_item_urls WHERE item_id = ?').run(itemId);
  const { urls: clean } = normalizeUrls(urls);
  if (!clean.length) return;
  const keepCheck = db.prepare(
    `UPDATE research_item_urls SET checked_at = ?, check_ok = ?, check_code = ?, check_error = ?
      WHERE id = ?`
  );
  const ins = db.prepare(
    `INSERT INTO research_item_urls (item_id, url, label, position, created_at)
     VALUES (?, ?, ?, ?, ${NOW_ISO_SQL})`
  );
  let pos = 0;
  for (const { url, label } of clean) {
    const newId = ins.run(itemId, url, label || null, pos++).lastInsertRowid;
    const prev = prevChecks.get(url);
    if (prev?.checked_at) keepCheck.run(prev.checked_at, prev.check_ok, prev.check_code, prev.check_error, newId);
  }
}

/** Status mehrerer Fundstuecke setzen — der EINE Schreibweg fuer Einzel-PATCH,
 *  Status-Board-Drag und Mehrfachauswahl. Haelt fest, wer und wann
 *  (`status_by` nur, wenn das Konto existiert: FK auf app_users). Gibt die Zahl
 *  geaenderter Zeilen zurueck. Aufrufer pruefen Status-Wert und Buch-Zugehoerigkeit. */
function setItemsStatus(ids, status, userEmail) {
  if (!ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  return db.prepare(
    `UPDATE research_items
        SET status = ?, status_at = ${NOW_ISO_SQL}, updated_at = ${NOW_ISO_SQL},
            status_by = (SELECT email FROM app_users WHERE email = ? COLLATE NOCASE)
      WHERE id IN (${ph})`
  ).run(status, userEmail || null, ...ids).changes;
}

function replaceTags(itemId, tags) {
  db.prepare('DELETE FROM research_item_tags WHERE item_id = ?').run(itemId);
  const clean = normalizeTags(tags);
  if (!clean.length) return;
  const ins = db.prepare('INSERT OR IGNORE INTO research_item_tags (item_id, tag) VALUES (?, ?)');
  for (const tag of clean) ins.run(itemId, tag);
}

/** Neues Fundstueck samt URLs, Tags und Suchindex. Erwartet BEREITS gepruefte
 *  Felder (Laengen/Kind) — die Eingangspruefung gehoert in die Route, die auch
 *  den 400 formulieren muss. Gibt die neue Id zurueck.
 *
 *  Als Transaktion, damit ein Fundstueck nie ohne seine URLs existiert: die URL
 *  ist bei einem aus dem Browser erfassten Link die einzige Substanz. */
const createItem = db.transaction(({ bookId, userEmail, kind, title, body, source, urls, tags, restore = null }) => {
  const k = RESEARCH_KINDS.has(kind) ? kind : 'note';
  const result = db.prepare(
    `INSERT INTO research_items (book_id, user_email, kind, title, body, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ${restore ? '?' : NOW_ISO_SQL}, ${NOW_ISO_SQL})`
  ).run(...[bookId, userEmail, k, title || null, body || null, source || null,
    ...(restore ? [restore.createdAt] : [])]);
  const id = result.lastInsertRowid;
  if (restore) {
    // Undo eines Löschens (lib/restore-fields.js): Stand aus dem Snapshot.
    // `status_by` ist wer wiederherstellt — ein Name aus dem Client wäre eine
    // frei wählbare Zuschreibung (nur, wenn das Konto existiert: FK auf app_users).
    db.prepare(`UPDATE research_items
                   SET status = COALESCE(?, status), status_at = ?,
                       status_by = (SELECT email FROM app_users WHERE email = ? COLLATE NOCASE),
                       pinned = ?, archived = ?
                 WHERE id = ?`)
      .run(restore.status, restore.statusAt, restore.status ? userEmail : null,
        restore.pinned ? 1 : 0, restore.archived ? 1 : 0, id);
  }
  replaceUrls(id, urls || []);
  replaceTags(id, tags || []);
  searchIndex.upsertResearch(id);
  return id;
});

/** Bestehendes, nicht archiviertes Fundstueck desselben Buchs, das denselben
 *  Inhalt bezeichnet — oder null. Zwei Achsen, in dieser Rangfolge:
 *    `url`   eine der URLs ist (normalisiert, lib/url-normalize) schon erfasst
 *    `title` der Titel ist (case-/whitespace-normalisiert) wortgleich
 *  Die URL-Achse ist hart (POST /research antwortet 409), die Titel-Achse nur
 *  ein Hinweis (Chat-Vorschlag „schon im Board?"): zwei Notizen duerfen gleich
 *  heissen, ein Link zweimal erfasst ist fast immer ein Versehen.
 *  @returns {null | { id, title, match: 'url'|'title', url? }} */
function findDuplicateItem(bookId, { urls = [], title = '' } = {}) {
  const wanted = new Map();
  for (const u of Array.isArray(urls) ? urls : []) {
    const raw = typeof u === 'string' ? u : u?.url;
    const n = normalizeUrl(raw);
    if (n && !wanted.has(n)) wanted.set(n, raw);
  }
  if (wanted.size) {
    const rows = db.prepare(
      `SELECT u.item_id, u.url, ri.title
         FROM research_item_urls u JOIN research_items ri ON ri.id = u.item_id
        WHERE ri.book_id = ? AND ri.archived = 0
        ORDER BY u.item_id`
    ).all(bookId);
    for (const r of rows) {
      if (wanted.has(normalizeUrl(r.url))) {
        return { id: r.item_id, title: r.title || '', match: 'url', url: r.url };
      }
    }
  }
  const t = normalizeTitleForMatch(title);
  if (t.length >= TITLE_MATCH_MIN) {
    const rows = db.prepare(
      `SELECT id, title FROM research_items
        WHERE book_id = ? AND archived = 0 AND title IS NOT NULL AND title != ''
        ORDER BY id`
    ).all(bookId);
    const hit = rows.find(r => normalizeTitleForMatch(r.title) === t);
    if (hit) return { id: hit.id, title: hit.title, match: 'title' };
  }
  return null;
}

/** 409-Body «diese URL liegt schon im Board» oder null — die harte URL-Achse
 *  von findDuplicateItem in der Antwortform, die POST /research und das Speichern
 *  eines Chat-Vorschlags teilen (Client-Vertrag: docs/clients.md). */
function urlDuplicateConflict(bookId, urls) {
  const dup = findDuplicateItem(bookId, { urls });
  if (!dup || dup.match !== 'url') return null;
  return {
    error_code: 'DUPLICATE_URL',
    existing_id: dup.id,
    params: { existing_id: dup.id, title: dup.title || dup.url || '' },
  };
}

/** Verknuepfung Fundstueck → Buch-Entitaet anlegen (idempotent). Das Ziel muss
 *  zum Buch des Fundstuecks gehoeren. Geteilt von POST /research/:id/links und
 *  dem Speichern eines Chat-Vorschlags mit Seiten-/Kapitel-Kontext.
 *  @returns {null | 'INVALID_TARGET' | 'BOOK_MISMATCH'} null = ok */
function addItemLink(itemId, bookId, targetKind, targetId) {
  const t = linkTarget(targetKind);
  const tid = parseInt(targetId, 10);
  if (!t || !Number.isInteger(tid) || tid <= 0) return 'INVALID_TARGET';
  const owner = db.prepare(`SELECT book_id FROM ${t.table} WHERE ${t.pk} = ?`).get(tid);
  if (!owner || owner.book_id !== bookId) return 'BOOK_MISMATCH';
  try {
    db.prepare(
      `INSERT INTO research_item_links (item_id, target_kind, ${t.col}, created_at)
       VALUES (?, ?, ?, ${NOW_ISO_SQL})`
    ).run(itemId, targetKind, tid);
  } catch (e) {
    // UNIQUE-Verstoss = Verknuepfung existiert bereits → idempotent.
    if (!/UNIQUE/.test(e.message)) throw e;
  }
  return null;
}

/** Buch-ID eines Items (oder null) — Lookup statt padden: ACL-/Media-Wege
 *  brauchen diese Information, ohne die ganze Zeile zu laden. */
function itemBookId(id) {
  const r = db.prepare('SELECT book_id FROM research_items WHERE id = ?').get(id);
  return r?.book_id || null;
}

/** Anzeigetitel eines Items (Titel, sonst Dokumentname) fuer Treffer des
 *  Embedding-Index (Kind `research`). undefined = Item fehlt. Buchweit geteilt,
 *  darum ohne User-Scope (siehe Kopf des Moduls). */
function itemTitle(id) {
  const r = db.prepare("SELECT COALESCE(NULLIF(title,''), doc_name, '') AS t FROM research_items WHERE id = ?").get(id);
  return r ? r.t : undefined;
}

// Welt-Dimensionen des Buchs (user-skopiert: Figuren, Orte, Szenen, Beats,
// Straenge) als Liste `{ id, label, ... }`. Die EINE Quelle fuer Tabelle,
// Label-Spalte und Grundordnung (LINK_TARGETS): Link-Picker hier und die
// Welt-Uebersicht der agentischen Chats (db/book-chat/research.js) bauen ihre
// Abfrage darueber, statt dieselben fuenf SELECTs zweimal zu pflegen.
//   publicId    `id` = oeffentliche Kennung (fig_id/loc_id) statt INTEGER-PK
//   extraCols   weitere Spalten der Tabelle
//   orderPrefix Wichtigkeits-Sortierung vor der kuratierten Grundordnung
//   activeOnly  nur aktive Figuren (db/figures/active.js) — fuer KI-Kontext
const WORLD_KINDS = ['figure', 'location', 'scene', 'beat', 'thread'];
function worldEntityStmt(kind, { publicId = false, extraCols = [], orderPrefix = '', activeOnly = false } = {}) {
  if (!WORLD_KINDS.includes(kind)) throw new Error(`worldEntityStmt: keine Welt-Dimension «${kind}»`);
  const t = LINK_TARGETS[kind];
  const idCol = publicId && t.refCol ? t.refCol : t.pk;
  const where = ['book_id = ?', 'user_email = ?'];
  if (activeOnly && kind === 'figure') where.push(activeFigureSql(t.table));
  return db.prepare(
    `SELECT ${[`${idCol} AS id`, `${t.nameCol} AS label`, ...extraCols].join(', ')}
       FROM ${t.table} WHERE ${where.join(' AND ')}
      ORDER BY ${orderPrefix}${t.orderCol}, ${t.nameCol}`
  );
}

// Link-Picker: NUR die user-skopierten Dimensionen — Kapitel und Seiten holt
// der Aufrufer ueber die Content-Store-Facade, weil `chapters`/`pages` niemand
// ausser ihr liest. Wo eine „Wichtigkeit" existiert, wird primaer danach
// sortiert — Figuren nach praesenz (zentral→randfigur), Beats nach intensitaet
// (5→1). Orte, Szenen und Straenge folgen ihrer kuratierten Ordnung.
const _entityTargetStmts = {
  figure: worldEntityStmt('figure', {
    orderPrefix: `CASE praesenz WHEN 'zentral' THEN 0 WHEN 'regelmaessig' THEN 1
                               WHEN 'punktuell' THEN 2 WHEN 'randfigur' THEN 3 ELSE 4 END, `,
  }),
  location: worldEntityStmt('location'),
  scene: worldEntityStmt('scene'),
  beat: worldEntityStmt('beat', {
    orderPrefix: 'CASE WHEN intensitaet IS NULL THEN 1 ELSE 0 END, intensitaet DESC, ',
  }),
  thread: worldEntityStmt('thread'),
};

function listEntityLinkTargets(bookId, userEmail) {
  const out = {};
  for (const [kind, stmt] of Object.entries(_entityTargetStmts)) {
    out[kind] = stmt.all(bookId, userEmail);
  }
  return out;
}

// Zwei gezielte Schreibpfade fuer die Interview-Transkription. Sie standen als
// rohes SQL im Route-Handler (routes/interview.js) — dort mit `db.prepare` je
// Request, was better-sqlite3 nicht cacht, und ausserhalb jeder Uebersicht
// darueber, wer `research_items` anfasst.
//
// Beide bewegen `updated_at` mit: der Kind-Wechsel und ein neu gesetzter
// Volltext sind Aenderungen am Fundstueck, und der Sync-Delta der Clients haengt
// an diesem Stempel.

const _stmtSetKind = db.prepare(
  `UPDATE research_items SET kind = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?`,
);
const _stmtSetDocText = db.prepare(
  `UPDATE research_items SET doc_text = ?, doc_chars = ?, updated_at = ${NOW_ISO_SQL} WHERE id = ?`,
);

/** Art des Fundstuecks setzen (die Transkription macht daraus 'transcript'). */
function setItemKind(id, kind) {
  return _stmtSetKind.run(kind, parseInt(id)).changes > 0;
}

/**
 * Volltext des Fundstuecks neu setzen. Der Aufrufer stoesst danach den
 * Suchindex an (`searchIndex.upsertResearch`) — bewusst dort und nicht hier:
 * der Transkript-Weg schreibt den Text mehrfach hintereinander, und jedes Mal
 * neu zu indizieren waere Arbeit fuer einen Zwischenstand.
 */
function setItemDocText(id, text) {
  const s = String(text || '');
  return _stmtSetDocText.run(s, s.length, parseInt(id)).changes > 0;
}

// Bezeichnung EINES Links setzen. Gezielt statt ueber replaceUrls, weil das die
// Kind-Tabelle neu schreibt und dabei neue `url_id` vergibt — die halten das
// Frontend (x-for-key) und jeder Aufrufer in der Hand, der gleich danach
// POST /sources/from-research mit genau dieser Id schickt.
//
// Aufrufer: der Scrape-Weg (routes/research-scrape.js), der die nackte URL aus
// der Teilen-Funktion mit dem Seitentitel benennt.
const _stmtSetUrlLabel = db.prepare(
  'UPDATE research_item_urls SET label = ? WHERE id = ? AND item_id = ?',
);

/** Label eines Links setzen. `item_id` steht mit im WHERE, damit ein fremdes
 *  `url_id` nicht die Zeile eines anderen Fundstuecks trifft. */
function setUrlLabel(itemId, urlId, label) {
  return _stmtSetUrlLabel.run(String(label || '') || null, parseInt(urlId), parseInt(itemId)).changes > 0;
}

// Fundstueck-Ids eines Buchs an einer Stelle: `pageId` = an dieser Seite
// verknuepft; `chapterId` = an einem Kapitel seines Teilbaums ODER an einem
// Abschnitt darin (Regel: db/research-findings.js#chapterPlace). Liegt hier,
// weil die Stelle Buchstruktur liest — Handler fragen das Modul, nicht `pages`.
function itemIdsAtPlace(bookId, { pageId = null, chapterId = null } = {}) {
  if (pageId) {
    return db.prepare(
      `SELECT DISTINCT l.item_id AS id FROM research_item_links l
         JOIN research_items ri ON ri.id = l.item_id
        WHERE ri.book_id = ? AND l.target_kind = 'page' AND l.page_id = ?`
    ).all(bookId, pageId).map(r => r.id);
  }
  if (chapterId) {
    const { chapterIds, pageIds } = chapterPlace(chapterId);
    if (!chapterIds.length) return [];
    const ph = (a) => a.map(() => '?').join(',');
    const pageClause = pageIds.length ? ` OR (l.target_kind = 'page' AND l.page_id IN (${ph(pageIds)}))` : '';
    return db.prepare(
      `SELECT DISTINCT l.item_id AS id FROM research_item_links l
         JOIN research_items ri ON ri.id = l.item_id
        WHERE ri.book_id = ?
          AND ((l.target_kind = 'chapter' AND l.chapter_id IN (${ph(chapterIds)}))${pageClause})`
    ).all(bookId, ...chapterIds, ...pageIds).map(r => r.id);
  }
  return [];
}

// Alle URLs der nicht archivierten Fundstuecke eines Buchs. Dient dem
// Recherche-Chat als Herkunfts-Allowlist fuer `read_web_page`: was im Board
// steht, hat der Autor selbst gesammelt und darf gelesen werden.
function bookItemUrls(bookId) {
  return db.prepare(
    `SELECT u.url FROM research_item_urls u
       JOIN research_items ri ON ri.id = u.item_id
      WHERE ri.book_id = ? AND ri.archived = 0`
  ).all(bookId).map(r => r.url);
}

module.exports = {
  LINK_TARGETS,
  linkTarget,
  worldEntityStmt,
  bookItemUrls,
  STATUS_SELECT_SQL,
  setItemsStatus,
  itemIdsAtPlace,
  attachRelations,
  emitItem,
  replaceUrls,
  replaceTags,
  createItem,
  findDuplicateItem,
  urlDuplicateConflict,
  addItemLink,
  itemBookId,
  itemTitle,
  listEntityLinkTargets,
  setItemKind,
  setItemDocText,
  setUrlLabel,
};
