'use strict';
// Befunde des Recherche-Abgleichs (Tabelle research_item_findings, Job
// research-crosscheck): Manuskriptstelle widerspricht einem gesammelten Fakt bzw.
// gibt ein gesammeltes Zitat abweichend wieder. Abgeleiteter Index — jeder Lauf
// ersetzt die Befunde der geprueften Fundstuecke, es gibt keinen Edit-Pfad.
// Seitennamen kommen hier per JOIN dazu (Handler lesen `pages` nicht selbst).

const { db } = require('./connection');
const { globalPageOrderSql, chapterSubtreeFilter } = require('./book-order');
const { NOW_ISO_SQL } = require('./now');

const FINDING_TYPES = new Set(['widerspruch', 'zitat']);

/** Befunde der gegebenen Fundstuecke ersetzen (geprueft = auch ohne Befund leeren). */
const replaceFindings = db.transaction((bookId, checkedItemIds, findings) => {
  if (checkedItemIds.length) {
    db.prepare(`DELETE FROM research_item_findings WHERE book_id = ? AND item_id IN (${checkedItemIds.map(() => '?').join(',')})`)
      .run(bookId, ...checkedItemIds);
  }
  const ins = db.prepare(
    `INSERT INTO research_item_findings (item_id, book_id, page_id, typ, stelle, erklaerung, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ${NOW_ISO_SQL})`
  );
  for (const f of findings) {
    if (!FINDING_TYPES.has(f.typ)) continue;
    ins.run(f.item_id, bookId, f.page_id, f.typ, f.stelle, f.erklaerung || null);
  }
});

/** Map item_id → [{ id, page_id, page_name, typ, stelle, erklaerung, created_at }]. */
function findingsByItem(itemIds) {
  const map = new Map();
  if (!itemIds.length) return map;
  const rows = db.prepare(
    `SELECT f.id, f.item_id, f.page_id, p.page_name, f.typ, f.stelle, f.erklaerung, f.created_at
       FROM research_item_findings f
       JOIN pages p ON p.page_id = f.page_id
       LEFT JOIN chapters c ON c.chapter_id = p.chapter_id
      WHERE f.item_id IN (${itemIds.map(() => '?').join(',')})
      ORDER BY f.item_id, ${globalPageOrderSql()}, f.id`
  ).all(...itemIds);
  for (const r of rows) {
    if (!map.has(r.item_id)) map.set(r.item_id, []);
    map.get(r.item_id).push({
      id: r.id, page_id: r.page_id, page_name: r.page_name || '', typ: r.typ,
      stelle: r.stelle, erklaerung: r.erklaerung || '', created_at: r.created_at,
    });
  }
  return map;
}

// Eine Kapitel-Stelle meint ihren ganzen Teilbaum (docs/chapter-hierarchy.md):
// ein Fundstueck am Teil «Erster Teil» gehoert auch zu den Abschnitten seiner
// Unterkapitel — ein Kapitel, das nur Unterkapitel traegt, waere sonst leer.
// Der EINE Ort dieser Regel fuer das Recherche-Board: itemIdsAtPlace (Chat-
// Kontext, list_research) und placePageIds (Recherche-Abgleich) fragen beide hier.
/** Kapitel-Teilbaum einer Stelle: `chapterIds` (Kapitel selbst + Unterkapitel)
 *  und `pageIds` (ihre Abschnitte in Lesereihenfolge: eigene Abschnitte eines
 *  Kapitels vor denen seiner Unterkapitel). */
function chapterPlace(chapterId) {
  const { sql, params } = chapterSubtreeFilter('chapter_id', chapterId);
  const chapters = db.prepare(
    `SELECT chapter_id, parent_chapter_id, position FROM chapters WHERE ${sql}`
  ).all(...params);
  if (!chapters.length) return { chapterIds: [], pageIds: [] };
  const children = new Map();
  for (const c of chapters) {
    if (!children.has(c.parent_chapter_id)) children.set(c.parent_chapter_id, []);
    children.get(c.parent_chapter_id).push(c);
  }
  for (const list of children.values()) list.sort((a, b) => (a.position - b.position) || (a.chapter_id - b.chapter_id));
  const ordered = [];
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    ordered.push(id);
    for (const c of children.get(id) || []) walk(c.chapter_id);
  };
  walk(chapterId);
  const pages = db.prepare(
    `SELECT page_id, chapter_id FROM pages WHERE ${sql} ORDER BY position, page_id`
  ).all(...params);
  const byChapter = new Map();
  for (const p of pages) {
    if (!byChapter.has(p.chapter_id)) byChapter.set(p.chapter_id, []);
    byChapter.get(p.chapter_id).push(p.page_id);
  }
  return { chapterIds: ordered, pageIds: ordered.flatMap(id => byChapter.get(id) || []) };
}

/** Seiten, an denen ein Fundstueck verknuepft ist: direkt an der Seite oder ueber
 *  ein verknuepftes Kapitel (die Abschnitte seines Teilbaums in Lesereihenfolge,
 *  je verknuepftem Kapitel hoechstens `maxPerChapter`). */
function placePageIds(itemId, { maxPerChapter = 3 } = {}) {
  const direct = db.prepare(
    `SELECT page_id FROM research_item_links WHERE item_id = ? AND target_kind = 'page' AND page_id IS NOT NULL`
  ).all(itemId).map(r => r.page_id);
  const linkedChapters = db.prepare(
    `SELECT chapter_id FROM research_item_links
      WHERE item_id = ? AND target_kind = 'chapter' AND chapter_id IS NOT NULL
      ORDER BY id`
  ).all(itemId).map(r => r.chapter_id);
  const out = [...direct];
  for (const chapterId of linkedChapters) {
    let n = 0;
    for (const pageId of chapterPlace(chapterId).pageIds) {
      if (n >= maxPerChapter) break;
      if (out.includes(pageId)) continue;
      out.push(pageId);
      n += 1;
    }
  }
  return out;
}

module.exports = { FINDING_TYPES, replaceFindings, findingsByItem, placePageIds, chapterPlace };
