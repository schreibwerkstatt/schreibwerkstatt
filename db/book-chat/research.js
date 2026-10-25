'use strict';
// SQL der Recherche-Werkzeuge der Chats (routes/jobs/chat-tools/tools-research.js):
// Archiv-Liste mit Filtern, Volltext eines Eintrags, Treffer-Metadaten der
// semantischen Suche, kompakte Welt-Übersicht. Alle Abfragen auf das Buch begrenzt.

const { db } = require('../connection');

const _in = (ids) => ids.map(() => '?').join(',');

const _stmtCountActive = db.prepare('SELECT COUNT(*) AS n FROM research_items WHERE book_id = ? AND archived = 0');

/** Anzahl nicht archivierter Einträge eines Buchs. */
function countActiveResearchItems(bookId) {
  return _stmtCountActive.get(bookId)?.n || 0;
}

/**
 * Nicht archivierte Einträge mit optionalen Filtern, angeheftete und jüngste zuerst.
 * @param {number} bookId
 * @param {{ kind?: string, status?: string, ids?: number[]|null, limit: number }} opts
 *   ids = Vorauswahl (FTS-Treffer, Einträge an einer Stelle); null = keine
 * @returns {{ total: number, rows: Array }}
 */
function listResearchItemsFiltered(bookId, { kind = null, status = null, ids = null, limit }) {
  const where = ['ri.book_id = ?', 'ri.archived = 0'];
  const vals = [bookId];
  if (kind) { where.push('ri.kind = ?'); vals.push(kind); }
  if (status) { where.push('ri.status = ?'); vals.push(status); }
  if (Array.isArray(ids)) {
    if (!ids.length) return { total: 0, rows: [] };
    where.push(`ri.id IN (${_in(ids)})`);
    vals.push(...ids);
  }
  const sqlWhere = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM research_items ri WHERE ${sqlWhere}`).get(...vals)?.n || 0;
  const rows = db.prepare(
    `SELECT ri.id, ri.kind, ri.title, ri.body, ri.source, ri.doc_name, ri.status,
            (ri.doc_mime IS NOT NULL) AS has_doc
       FROM research_items ri
      WHERE ${sqlWhere}
      ORDER BY ri.pinned DESC, ri.updated_at DESC
      LIMIT ${Number(limit) | 0}`
  ).all(...vals);
  return { total, rows };
}

/** Tags je Eintrag: Map item_id → string[]. */
function researchTagsByItem(ids) {
  const out = new Map();
  if (!ids.length) return out;
  for (const t of db.prepare(`SELECT item_id, tag FROM research_item_tags WHERE item_id IN (${_in(ids)})`).all(...ids)) {
    if (!out.has(t.item_id)) out.set(t.item_id, []);
    out.get(t.item_id).push(t.tag);
  }
  return out;
}

/** URLs je Eintrag in Reihenfolge: Map item_id → string[]. */
function researchUrlsByItem(ids) {
  const out = new Map();
  if (!ids.length) return out;
  for (const u of db.prepare(`SELECT item_id, url FROM research_item_urls WHERE item_id IN (${_in(ids)}) ORDER BY item_id, position, id`).all(...ids)) {
    if (!out.has(u.item_id)) out.set(u.item_id, []);
    out.get(u.item_id).push(u.url);
  }
  return out;
}

const _stmtItemForRead = db.prepare(
  `SELECT id, kind, title, body, source, doc_name, doc_text, status
     FROM research_items WHERE id = ? AND book_id = ?`
);
const _stmtItemTags = db.prepare('SELECT tag FROM research_item_tags WHERE item_id = ? ORDER BY tag');
const _stmtItemUrls = db.prepare('SELECT url, label FROM research_item_urls WHERE item_id = ? ORDER BY position, id');

/** Ein Eintrag samt Tags und URLs (mit Label), nur aus diesem Buch; null wenn fremd/fehlt. */
function getResearchItemForRead(id, bookId) {
  const row = _stmtItemForRead.get(id, bookId);
  if (!row) return null;
  return {
    ...row,
    tags: _stmtItemTags.all(id).map(t => t.tag),
    urls: _stmtItemUrls.all(id).map(u => ({ url: u.url, label: u.label || '' })),
  };
}

const _stmtItemTitleInBook = db.prepare(
  "SELECT id, COALESCE(NULLIF(title,''), doc_name) AS title FROM research_items WHERE id = ? AND book_id = ?"
);

/** { id, title } eines Eintrags dieses Buchs, sonst null (Buch-Guard der Passagen-Suche). */
function getResearchItemTitleInBook(id, bookId) {
  return _stmtItemTitleInBook.get(id, bookId) || null;
}

/** Metadaten der Treffer-Einträge (nur dieses Buch): Map id → { id, kind, title, doc_name }. */
function researchItemMeta(bookId, ids) {
  if (!ids.length) return new Map();
  return new Map(
    db.prepare(
      `SELECT id, kind, COALESCE(NULLIF(title,''), doc_name) AS title, doc_name
         FROM research_items WHERE book_id = ? AND id IN (${_in(ids)})`
    ).all(bookId, ...ids).map(r => [r.id, r])
  );
}

// Figuren/Orte mit ihrer öffentlichen Kennung (fig_id/loc_id) als `id` — die
// INTEGER-PK bleibt im Server.
const _entityStmts = {
  figur:  db.prepare('SELECT fig_id AS id, name AS label, typ, rolle, beschreibung FROM figures WHERE book_id = ? AND user_email = ? AND COALESCE(stale,0) = 0 ORDER BY sort_order, name'),
  ort:    db.prepare('SELECT loc_id AS id, name AS label, typ, land, beschreibung FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order, name'),
  szene:  db.prepare('SELECT id, titel AS label, kommentar FROM figure_scenes WHERE book_id = ? AND user_email = ? ORDER BY sort_order, titel'),
  beat:   db.prepare('SELECT id, titel AS label, beschreibung FROM plot_beats WHERE book_id = ? AND user_email = ? ORDER BY sort_order, titel'),
  strang: db.prepare('SELECT id, name AS label FROM plot_threads WHERE book_id = ? AND user_email = ? ORDER BY position, name'),
};

/** Rohzeilen einer Welt-Kategorie (figur | ort | szene | beat | strang); [] bei unbekannter Art. */
function listBookEntityRows(art, bookId, userEmail) {
  const stmt = _entityStmts[art];
  return stmt ? stmt.all(bookId, userEmail || null) : [];
}

module.exports = {
  countActiveResearchItems,
  listResearchItemsFiltered,
  researchTagsByItem,
  researchUrlsByItem,
  getResearchItemForRead,
  getResearchItemTitleInBook,
  researchItemMeta,
  listBookEntityRows,
};
