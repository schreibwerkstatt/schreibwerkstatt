'use strict';
// SSoT fuer Buch-Hierarchie.
//
// order_json-Format (Buch -> Kapitel|Seite, Kapitel -> Kapitel|Seite, max
// MAX_CHAPTER_DEPTH Kapitel-Ebenen):
//   [
//     { "type": "chapter", "id": 42, "children": [
//         { "type": "chapter", "id": 50, "children": [
//             { "type": "page", "id": 200 }
//         ]},
//         { "type": "page", "id": 101 }
//     ]},
//     { "type": "page", "id": 103 }
//   ]
//
// PUT-Hook validiert + materialisiert in einer Transaction:
//   - chapters.position          (0-basiert, lueckenlos in Depth-First-Tree-Reihenfolge)
//   - chapters.parent_chapter_id (NULL fuer Top-Level, sonst FK auf chapters)
//   - pages.position             (0-basiert, lueckenlos pro Bucket: Kapitel oder Top-Level)
//   - pages.chapter_id           (NULL fuer Top-Level, sonst FK auf Eltern-Kapitel)
//
// Materialisierte Spalten sind nur fuer Querys/JOINs (Filter, Sort in
// figures/locations/jobs). SSoT bleibt order_json — bookTree liest daraus.

const { db } = require('./connection');
require('./migrations');
const { NOW_ISO_SQL } = require('./now');

// Maximale Kapitel-Verschachtelung. Top-Level = 1, Sub = 2, Sub-Sub = 3.
// PDF-Renderer mapped 1→h1, 2→h2, 3→h3. Organizer-DnD blockt tiefer.
const MAX_CHAPTER_DEPTH = 3;

class TreeValidationError extends Error {
  constructor(code, detail = null) {
    super(`book_order tree invalid: ${code}${detail ? ` (${detail})` : ''}`);
    this.code = code;
    this.detail = detail;
    this.status = 400;
  }
}

function _knownIds(bookId) {
  const chapters = db.prepare('SELECT chapter_id FROM chapters WHERE book_id = ?').all(bookId);
  const pages = db.prepare('SELECT page_id FROM pages WHERE book_id = ?').all(bookId);
  return {
    chapterIds: new Set(chapters.map(r => r.chapter_id)),
    pageIds: new Set(pages.map(r => r.page_id)),
  };
}

function _validatePageEntry(entry, pageIds, seenPages) {
  if (!Number.isInteger(entry.id) || entry.id <= 0) {
    throw new TreeValidationError('BAD_ID', JSON.stringify(entry.id));
  }
  if (!pageIds.has(entry.id)) throw new TreeValidationError('UNKNOWN_PAGE', entry.id);
  if (seenPages.has(entry.id)) throw new TreeValidationError('DUPLICATE_PAGE', entry.id);
  if ('children' in entry && entry.children && entry.children.length) {
    throw new TreeValidationError('PAGE_HAS_CHILDREN', entry.id);
  }
  seenPages.add(entry.id);
}

function _validateChapterEntry(entry, depth, chapterIds, pageIds, seenChapters, seenPages) {
  if (!Number.isInteger(entry.id) || entry.id <= 0) {
    throw new TreeValidationError('BAD_ID', JSON.stringify(entry.id));
  }
  if (!chapterIds.has(entry.id)) throw new TreeValidationError('UNKNOWN_CHAPTER', entry.id);
  if (seenChapters.has(entry.id)) throw new TreeValidationError('DUPLICATE_CHAPTER', entry.id);
  if (depth > MAX_CHAPTER_DEPTH) throw new TreeValidationError('MAX_DEPTH', entry.id);
  seenChapters.add(entry.id);
  const children = entry.children || [];
  if (!Array.isArray(children)) throw new TreeValidationError('CHILDREN_NOT_ARRAY', entry.id);
  for (const child of children) {
    if (!child || typeof child !== 'object') throw new TreeValidationError('CHILD_NOT_OBJECT');
    if (child.type === 'chapter') {
      if (depth >= MAX_CHAPTER_DEPTH) throw new TreeValidationError('MAX_DEPTH', child.id);
      _validateChapterEntry(child, depth + 1, chapterIds, pageIds, seenChapters, seenPages);
    } else if (child.type === 'page') {
      _validatePageEntry(child, pageIds, seenPages);
    } else {
      throw new TreeValidationError('BAD_TYPE', String(child.type));
    }
  }
}

function validateTree(tree, bookId) {
  if (!Array.isArray(tree)) throw new TreeValidationError('NOT_ARRAY');
  const { chapterIds, pageIds } = _knownIds(bookId);
  const seenChapters = new Set();
  const seenPages = new Set();

  for (const entry of tree) {
    if (!entry || typeof entry !== 'object') throw new TreeValidationError('ENTRY_NOT_OBJECT');
    if (entry.type === 'chapter') {
      _validateChapterEntry(entry, 1, chapterIds, pageIds, seenChapters, seenPages);
    } else if (entry.type === 'page') {
      _validatePageEntry(entry, pageIds, seenPages);
    } else {
      throw new TreeValidationError('BAD_TYPE', String(entry.type));
    }
  }

  if (seenChapters.size !== chapterIds.size) {
    const missing = [...chapterIds].filter(id => !seenChapters.has(id));
    throw new TreeValidationError('MISSING_CHAPTER', JSON.stringify(missing.slice(0, 5)));
  }
  if (seenPages.size !== pageIds.size) {
    const missing = [...pageIds].filter(id => !seenPages.has(id));
    throw new TreeValidationError('MISSING_PAGE', JSON.stringify(missing.slice(0, 5)));
  }
}

// Materialisiert die Tree-Reihenfolge in chapters.position/parent_chapter_id/
// pages.position/pages.chapter_id. chapters.position ist 0-basiert + lueckenlos
// in Depth-First-Tree-Reihenfolge (globaler Sort-Hint fuer listChapters).
// pages.position bleibt 0-basiert + lueckenlos pro Bucket (Eltern-Kapitel oder
// Top-Level). Caller wrapped in Tx.
function materializeTree(bookId, tree) {
  const updateChapter = db.prepare('UPDATE chapters SET position = ?, parent_chapter_id = ? WHERE chapter_id = ? AND book_id = ?');
  const updatePage = db.prepare('UPDATE pages SET position = ?, chapter_id = ? WHERE page_id = ? AND book_id = ?');

  const chapterIdxRef = { value: 0 };

  function walkChapter(entry, parentChapterId) {
    updateChapter.run(chapterIdxRef.value, parentChapterId, entry.id, bookId);
    chapterIdxRef.value++;
    let pageIdx = 0;
    for (const child of (entry.children || [])) {
      if (child.type === 'chapter') {
        walkChapter(child, entry.id);
      } else {
        updatePage.run(pageIdx, entry.id, child.id, bookId);
        pageIdx++;
      }
    }
  }

  let topPageIdx = 0;
  for (const entry of tree) {
    if (entry.type === 'chapter') {
      walkChapter(entry, null);
    } else {
      updatePage.run(topPageIdx, null, entry.id, bookId);
      topPageIdx++;
    }
  }
}

function _getRowStmt() {
  return db.prepare('SELECT book_id, order_json, updated_at, updated_by FROM book_order WHERE book_id = ?');
}

function getOrder(bookId) {
  const r = _getRowStmt().get(bookId);
  if (!r) return null;
  let tree = null;
  try { tree = JSON.parse(r.order_json); }
  catch { tree = null; }
  return { tree, updated_at: r.updated_at, updated_by: r.updated_by };
}

const _upsertStmt = db.prepare(`
  INSERT INTO book_order (book_id, order_json, updated_at, updated_by)
  VALUES (?, ?, ${NOW_ISO_SQL}, ?)
  ON CONFLICT(book_id) DO UPDATE SET
    order_json = excluded.order_json,
    updated_at = ${NOW_ISO_SQL},
    updated_by = excluded.updated_by
`);

// Order-Overlay eines Buchs loeschen — ensureTree baut danach frisch aus den
// aktuellen pages.position/chapters.position auf (buildFromCurrentState). Noetig
// nach einem Voll-Wipe (z.B. Fassungs-Restore), weil die alte Row sonst auf
// geloeschte Page-/Chapter-IDs zeigt.
const _deleteOrderStmt = db.prepare('DELETE FROM book_order WHERE book_id = ?');
function clearOrder(bookId) {
  _deleteOrderStmt.run(bookId);
}

// Validiert + materialisiert + persistiert in einer Transaction.
function putOrder(bookId, tree, userEmail = null) {
  validateTree(tree, bookId);
  const json = JSON.stringify(tree);
  const tx = db.transaction(() => {
    materializeTree(bookId, tree);
    _upsertStmt.run(bookId, json, userEmail);
  });
  tx();
  return getOrder(bookId);
}

// Initial-Fill: Tree aus aktuellen pages.position/chapters.position
// + chapters.parent_chapter_id ableiten. Verwendet vom
// Backfill + bookTree-Read, wenn noch keine book_order-Row existiert.
function buildFromCurrentState(bookId) {
  const chapters = db.prepare(`
    SELECT chapter_id, parent_chapter_id, COALESCE(position, 0) AS pos
      FROM chapters WHERE book_id = ?
     ORDER BY COALESCE(position, 0), chapter_id
  `).all(bookId);
  const pages = db.prepare(`
    SELECT page_id, chapter_id, COALESCE(position, 0) AS pos
      FROM pages WHERE book_id = ?
     ORDER BY COALESCE(position, 0), page_id
  `).all(bookId);

  const pagesByChapter = new Map();
  const topPages = [];
  for (const p of pages) {
    if (p.chapter_id) {
      if (!pagesByChapter.has(p.chapter_id)) pagesByChapter.set(p.chapter_id, []);
      pagesByChapter.get(p.chapter_id).push(p);
    } else {
      topPages.push(p);
    }
  }

  const subchaptersByParent = new Map();
  const topChapters = [];
  for (const c of chapters) {
    if (c.parent_chapter_id) {
      if (!subchaptersByParent.has(c.parent_chapter_id)) subchaptersByParent.set(c.parent_chapter_id, []);
      subchaptersByParent.get(c.parent_chapter_id).push(c);
    } else {
      topChapters.push(c);
    }
  }

  // Stable order pro Bucket: Sub-Kapitel zuerst, dann Seiten (Heuristik —
  // gemischte Reihenfolge ohne order_json nicht rekonstruierbar; Sub-Kapitel
  // sind die spaeter eingefuehrte Ebene, daher first).
  function buildChapterNode(c) {
    const subs = (subchaptersByParent.get(c.chapter_id) || [])
      .sort((a, b) => a.pos - b.pos || a.chapter_id - b.chapter_id)
      .map(buildChapterNode);
    const subPages = (pagesByChapter.get(c.chapter_id) || [])
      .map(p => ({ type: 'page', id: p.page_id }));
    return { type: 'chapter', id: c.chapter_id, children: [...subs, ...subPages] };
  }

  const mixed = [
    ...topChapters.map(c => ({ type: 'chapter', id: c.chapter_id, pos: c.pos })),
    ...topPages.map(p => ({ type: 'page', id: p.page_id, pos: p.pos })),
  ].sort((a, b) => {
    if (a.pos !== b.pos) return a.pos - b.pos;
    if (a.type !== b.type) return a.type === 'chapter' ? -1 : 1;
    return a.id - b.id;
  });

  return mixed.map(e => {
    if (e.type === 'chapter') {
      const c = topChapters.find(x => x.chapter_id === e.id);
      return buildChapterNode(c);
    }
    return { type: 'page', id: e.id };
  });
}

// Reconciliation: stored tree mit aktuellem DB-Stand abgleichen. Items, die
// in der DB nicht (mehr) existieren, fliegen raus; neue Items werden ans Ende
// angehaengt (Kapitel als leeres Top-Level-Kapitel, Seiten als Top-Level).
// Verwendet vom Lese-Pfad nach Importen oder nach
// CRUD-Operationen, die book_order nicht selbst pflegen.
function reconcile(bookId, storedTree) {
  const { chapterIds, pageIds } = _knownIds(bookId);
  const seenChapters = new Set();
  const seenPages = new Set();

  function reconcileChapter(entry, depth) {
    if (!chapterIds.has(entry.id) || seenChapters.has(entry.id)) return null;
    if (depth > MAX_CHAPTER_DEPTH) return null;
    seenChapters.add(entry.id);
    const children = [];
    for (const child of (entry.children || [])) {
      if (!child || typeof child !== 'object') continue;
      if (child.type === 'chapter') {
        const rec = reconcileChapter(child, depth + 1);
        if (rec) children.push(rec);
      } else if (child.type === 'page') {
        if (!pageIds.has(child.id) || seenPages.has(child.id)) continue;
        seenPages.add(child.id);
        children.push({ type: 'page', id: child.id });
      }
    }
    return { type: 'chapter', id: entry.id, children };
  }

  const reconciled = [];
  for (const entry of (storedTree || [])) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'chapter') {
      const rec = reconcileChapter(entry, 1);
      if (rec) reconciled.push(rec);
    } else if (entry.type === 'page') {
      if (!pageIds.has(entry.id) || seenPages.has(entry.id)) continue;
      seenPages.add(entry.id);
      reconciled.push({ type: 'page', id: entry.id });
    }
  }

  // Sammle alle Kapitel-Nodes (rekursiv) fuer Lookup beim Page-Bucketing +
  // Subchapter-Re-Parenting.
  function walkAllChapters(nodes, cb) {
    for (const n of nodes) {
      if (n.type !== 'chapter') continue;
      cb(n);
      walkAllChapters(n.children || [], cb);
    }
  }
  const chapterEntry = new Map();
  walkAllChapters(reconciled, n => chapterEntry.set(n.id, n));

  // Fehlende Kapitel: bevorzugt unter ihrem Eltern-Kapitel einsortieren (via
  // parent_chapter_id). Wenn Parent fehlt oder Tiefe ueberschritten → top-level.
  const missingChapters = [...chapterIds].filter(id => !seenChapters.has(id)).sort((a, b) => a - b);
  if (missingChapters.length) {
    const placeholders = missingChapters.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT chapter_id, parent_chapter_id FROM chapters WHERE chapter_id IN (${placeholders})`
    ).all(...missingChapters);
    const parentByChapter = new Map(rows.map(r => [r.chapter_id, r.parent_chapter_id]));

    function chapterDepth(node) {
      let d = 1;
      let cur = node;
      while (cur) {
        const parentId = parentByChapter.get(cur.id);
        if (!parentId) {
          for (const top of reconciled) if (top === cur) return d;
          return d;
        }
        const parentNode = chapterEntry.get(parentId);
        if (!parentNode) return d;
        d++;
        cur = parentNode;
      }
      return d;
    }

    for (const chId of missingChapters) {
      seenChapters.add(chId);
      const newNode = { type: 'chapter', id: chId, children: [] };
      const parentId = parentByChapter.get(chId);
      const parentNode = parentId ? chapterEntry.get(parentId) : null;
      const depth = parentNode ? chapterDepth(parentNode) + 1 : 1;
      if (parentNode && depth <= MAX_CHAPTER_DEPTH) {
        parentNode.children.push(newNode);
      } else {
        reconciled.push(newNode);
      }
      chapterEntry.set(chId, newNode);
    }
  }

  // Restliche Seiten: bevorzugt unter ihrem Kapitel einsortieren (pages.chapter_id).
  // Top-Level nur, wenn chapter_id NULL ist oder das Kapitel nicht im Tree liegt.
  // Why: createPage/Direct-Insert pflegt book_order nicht. Ohne Bucket-Lookup
  // landen frisch angelegte Kapitel-Seiten beim ersten bookTree-Read als Waisen.
  const missingPages = [...pageIds].filter(id => !seenPages.has(id)).sort((a, b) => a - b);
  if (missingPages.length) {
    const placeholders = missingPages.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT page_id, chapter_id FROM pages WHERE page_id IN (${placeholders})`
    ).all(...missingPages);
    const chapterByPage = new Map(rows.map(r => [r.page_id, r.chapter_id]));
    for (const pId of missingPages) {
      const chId = chapterByPage.get(pId) || null;
      const ch = chId ? chapterEntry.get(chId) : null;
      if (ch) ch.children.push({ type: 'page', id: pId });
      else reconciled.push({ type: 'page', id: pId });
    }
  }

  return reconciled;
}

// Liefert die aktuelle Tree-Struktur. Mit Auto-Init: keine Row -> aus
// Bestand bauen + persistieren. Mit Auto-Reconcile: vorhandene Row gegen
// aktuellen DB-Stand abgleichen, falls Items hinzugekommen/verschwunden sind
// (z.B. nach Import, Direct-Insert via API ausserhalb des PUT-Hooks).
//
// Defensiv: kein books-Row → kein Auto-Init, sonst FK-Violation gegen
// books(book_id); Caller (bookTree-Facade) faellt auf raw zurueck.
function ensureTree(bookId, userEmail = null) {
  const bookExists = db.prepare('SELECT 1 FROM books WHERE book_id = ?').get(bookId);
  if (!bookExists) return { tree: [], updated_at: null, updated_by: null };
  const existing = getOrder(bookId);
  if (!existing) {
    const tree = buildFromCurrentState(bookId);
    putOrder(bookId, tree, userEmail);
    return getOrder(bookId);
  }
  const reconciled = reconcile(bookId, existing.tree || []);
  const before = JSON.stringify(existing.tree || []);
  const after = JSON.stringify(reconciled);
  if (before === after) return existing;
  // Reconcile aendert nur die Menge, keine User-getriebene Reorder — ohne
  // updated_by-Update, damit „letzter Reorder durch X" valide bleibt.
  const tx = db.transaction(() => {
    materializeTree(bookId, reconciled);
    db.prepare(`UPDATE book_order SET order_json = ? WHERE book_id = ?`).run(after, bookId);
  });
  tx();
  return getOrder(bookId);
}

// Liefert alle Nachfahren-Kapitel-IDs (rekursiv) eines Kapitels via
// chapters.parent_chapter_id. Default exklusive Self. Genutzt von Jobs/Reviews
// fuer "Kapitel inkl. Sub-Kapitel"-Operationen.
function getDescendantChapterIds(chapterId, { includeSelf = false } = {}) {
  const rows = db.prepare(`
    WITH RECURSIVE descendants(chapter_id) AS (
      SELECT chapter_id FROM chapters WHERE parent_chapter_id = ?
      UNION ALL
      SELECT c.chapter_id FROM chapters c
        JOIN descendants d ON c.parent_chapter_id = d.chapter_id
    )
    SELECT chapter_id FROM descendants
  `).all(chapterId);
  const ids = rows.map(r => r.chapter_id);
  return includeSelf ? [chapterId, ...ids] : ids;
}

module.exports = {
  MAX_CHAPTER_DEPTH,
  validateTree,
  materializeTree,
  getOrder,
  putOrder,
  clearOrder,
  buildFromCurrentState,
  reconcile,
  ensureTree,
  getDescendantChapterIds,
  TreeValidationError,
};
