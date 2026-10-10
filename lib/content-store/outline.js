'use strict';
// Gliederung eines Buchs in Lesereihenfolge: Kapitel jeder Tiefe und Abschnitte
// verschränkt, so wie sie im Manuskript aufeinander folgen. Quelle der Reihenfolge
// ist book_order.order_json (SSoT, docs/chapter-hierarchy.md), nicht
// chapters/pages.position: pages.position zählt pro Bucket, und die Mischfolge aus
// eigenen Abschnitten und Unterkapiteln eines Kapitels steht nur im Tree. Auch
// bookTree() verliert sie (pages[] und subchapters[] getrennt) — darum hier ein
// eigener Walk über den Tree.

const localdbBackend = require('./backends/localdb');
const bookOrder = require('../../db/book-order');
const logger = require('../../logger');

/**
 * Pure: Tree + Kapitel-/Seiten-Metadaten → Knoten in Lesereihenfolge.
 *   Kapitel: { type:'chapter', id, name, depth (1–3), parent_id, path:[Namen Wurzel..selbst], chapter_ids:[ids Wurzel..selbst] }
 *   Abschnitt: { type:'page', id, name, chapter_id, depth (Tiefe des Kapitels, 0 = ohne Kapitel),
 *               path:[Kapitelnamen Wurzel..direktes Kapitel], chapter_ids:[ids Wurzel..direktes Kapitel] }
 * Knoten, die der Tree nicht kennt (Daten ausserhalb des Overlays), stehen am Ende —
 * Abschnitte darin mit ihrem Kapitel, sofern es im Buch liegt.
 */
function buildOutline(tree, chapters, pages) {
  const chById = new Map((chapters || []).map(c => [c.id, c]));
  const pgById = new Map((pages || []).map(p => [p.id, p]));
  const seenCh = new Set();
  const seenPg = new Set();
  const out = [];

  const pushPage = (p, chapterNode) => {
    seenPg.add(p.id);
    out.push({
      type: 'page', id: p.id, name: p.name || '',
      chapter_id: chapterNode ? chapterNode.id : null,
      depth: chapterNode ? chapterNode.depth : 0,
      path: chapterNode ? chapterNode.path : [],
      chapter_ids: chapterNode ? chapterNode.chapter_ids : [],
    });
  };

  (function walk(entries, parent) {
    for (const e of (entries || [])) {
      if (e?.type === 'chapter') {
        const ch = chById.get(e.id);
        if (!ch || seenCh.has(ch.id)) continue;
        seenCh.add(ch.id);
        const node = {
          type: 'chapter', id: ch.id, name: ch.name || '',
          depth: parent ? parent.depth + 1 : 1,
          parent_id: parent ? parent.id : null,
          path: [...(parent ? parent.path : []), ch.name || ''],
          chapter_ids: [...(parent ? parent.chapter_ids : []), ch.id],
        };
        out.push(node);
        walk(e.children, node);
      } else if (e?.type === 'page') {
        const p = pgById.get(e.id);
        if (p && !seenPg.has(p.id)) pushPage(p, parent);
      }
    }
  })(tree, null);

  // Defensiv: was der Tree nicht trägt, nicht verschlucken.
  const nodeById = new Map(out.filter(n => n.type === 'chapter').map(n => [n.id, n]));
  for (const ch of (chapters || [])) {
    if (seenCh.has(ch.id)) continue;
    const node = { type: 'chapter', id: ch.id, name: ch.name || '', depth: 1, parent_id: null, path: [ch.name || ''], chapter_ids: [ch.id] };
    nodeById.set(ch.id, node);
    out.push(node);
  }
  for (const p of (pages || [])) {
    if (!seenPg.has(p.id)) pushPage(p, p.chapter_id != null ? nodeById.get(p.chapter_id) || null : null);
  }
  return out;
}

/** Gliederung eines Buchs (siehe buildOutline). */
async function bookOutline(bookId, ctx) {
  const [chapters, pages] = await Promise.all([
    localdbBackend.listChapters(bookId, ctx),
    localdbBackend.listPages(bookId, ctx),
  ]);
  // Inkonsistente Daten (z.B. Seite, deren Kapitel in einem anderen Buch liegt)
  // lassen ensureTree an der Validierung scheitern. Eine Lese-Sicht darf daran
  // nicht zerbrechen: dann die Reihenfolge ungespeichert aus den Positionen bauen.
  let tree;
  try { tree = bookOrder.ensureTree(bookId)?.tree; }
  catch (e) {
    logger.warn(`[content-store] bookOutline: Order-Tree ungültig (book=${bookId}): ${e.message} – Positionen als Fallback.`);
    tree = bookOrder.buildFromCurrentState(bookId);
  }
  return buildOutline(tree || [], chapters, pages);
}

/** Abschnitte eines Kapitels in Lesereihenfolge; `includeSubchapters` nimmt die
 *  Abschnitte aller Unterkapitel (jeder Tiefe) an ihrer Stelle mit. */
function chapterPages(outline, chapterId, { includeSubchapters = true } = {}) {
  return outline.filter(n => n.type === 'page' && (includeSubchapters
    ? n.chapter_ids.includes(chapterId)
    : n.chapter_id === chapterId));
}

/** Kapitelpfad als Text («Teil 1 › Kapitel 2 › Szene»); leer ohne Kapitel. */
function formatChapterPath(path, sep = ' › ') {
  return (path || []).filter(Boolean).join(sep);
}

module.exports = { buildOutline, bookOutline, chapterPages, formatChapterPath };
