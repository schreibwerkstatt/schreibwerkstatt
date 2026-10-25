'use strict';
// Befunde des Recherche-Abgleichs (Tabelle research_item_findings, Job
// research-crosscheck): Manuskriptstelle widerspricht einem gesammelten Fakt bzw.
// gibt ein gesammeltes Zitat abweichend wieder. Abgeleiteter Index — jeder Lauf
// ersetzt die Befunde der geprueften Fundstuecke, es gibt keinen Edit-Pfad.
// Seitennamen kommen hier per JOIN dazu (Handler lesen `pages` nicht selbst).

const { db } = require('./connection');
const { globalPageOrderSql } = require('./book-order');
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

/** Seiten, an denen ein Fundstueck verknuepft ist: direkt an der Seite oder ueber
 *  ein verknuepftes Kapitel (dessen Seiten in Buch-Reihenfolge). */
function placePageIds(itemId, { maxPerChapter = 3 } = {}) {
  const direct = db.prepare(
    `SELECT page_id FROM research_item_links WHERE item_id = ? AND target_kind = 'page' AND page_id IS NOT NULL`
  ).all(itemId).map(r => r.page_id);
  const viaChapter = db.prepare(
    `SELECT p.page_id, p.chapter_id FROM research_item_links l
       JOIN pages p ON p.chapter_id = l.chapter_id
      WHERE l.item_id = ? AND l.target_kind = 'chapter'
      ORDER BY p.chapter_id, p.position`
  ).all(itemId);
  const perChapter = new Map();
  const out = [...direct];
  for (const r of viaChapter) {
    const n = perChapter.get(r.chapter_id) || 0;
    if (n >= maxPerChapter || out.includes(r.page_id)) continue;
    perChapter.set(r.chapter_id, n + 1);
    out.push(r.page_id);
  }
  return out;
}

module.exports = { FINDING_TYPES, replaceFindings, findingsByItem, placePageIds };
