'use strict';
// Reine Baum-Helfer der Content-Store-Facade: book_order-Overlay auf den
// Roh-Baum legen, flache Lesereihenfolge, Kapitel einfuegen/herausloesen.
// Ausgelagert, damit index.js unter dem LOC-Cap bleibt.

const bookOrder = require('../../db/book-order');

// `after_chapter_id`: Kapitel als Geschwister direkt hinter den Anker haengen
// (order_json ist SSoT; putOrder materialisiert die Positionen lueckenlos).
function placeChapterAfter(bookId, chapterId, anchorId) {
  const ordered = bookOrder.ensureTree(bookId);
  const tree = JSON.parse(JSON.stringify(ordered?.tree || []));
  const take = (nodes) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type !== 'chapter') continue;
      if (n.id === chapterId) return nodes.splice(i, 1)[0];
      const hit = take(n.children || []);
      if (hit) return hit;
    }
    return null;
  };
  const insert = (nodes, node) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type !== 'chapter') continue;
      if (n.id === anchorId) { nodes.splice(i + 1, 0, node); return true; }
      if (insert(n.children || [], node)) return true;
    }
    return false;
  };
  const node = take(tree) || { type: 'chapter', id: chapterId, children: [] };
  if (!insert(tree, node)) return;
  // updated_by bleibt beim letzten echten Umsortierer — Anlegen ist kein Reorder.
  bookOrder.putOrder(bookId, tree, ordered?.updated_by ?? null);
}

// Ersetzt den Kapitel-Knoten durch seine Kinder an derselben Stelle. null, wenn
// das Kapitel nicht im Tree steht.
function spliceChapterOut(tree, chapterId) {
  const walk = (nodes) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.type !== 'chapter') continue;
      if (n.id === chapterId) { nodes.splice(i, 1, ...(n.children || [])); return true; }
      if (walk(n.children || [])) return true;
    }
    return false;
  };
  return walk(tree) ? tree : null;
}

// Output-Format: chapters enthaelt nur Top-Level-Kapitel. Jedes Kapitel hat
// pages[] (direkt enthaltene Seiten) + subchapters[] (nested, gleiche Shape).
// Konsumenten, die alle Seiten flach brauchen, nutzen flattenTree().
function applyOrder(raw, tree) {
  const chaptersById = new Map((raw.chapters || []).map(c => [c.id, c]));
  const pagesById = new Map();
  for (const c of (raw.chapters || [])) for (const p of (c.pages || [])) pagesById.set(p.id, p);
  for (const p of (raw.topPages || [])) pagesById.set(p.id, p);

  function buildChapter(entry) {
    const ch = chaptersById.get(entry.id);
    if (!ch) return null;
    const pages = [];
    const subchapters = [];
    for (const child of (entry.children || [])) {
      if (child.type === 'chapter') {
        const sub = buildChapter(child);
        if (sub) subchapters.push(sub);
      } else if (child.type === 'page') {
        const p = pagesById.get(child.id);
        if (p) pages.push({ ...p, chapter_id: ch.id });
      }
    }
    return { ...ch, pages, subchapters };
  }

  const chaptersOut = [];
  const topPages = [];
  for (const entry of tree) {
    if (entry.type === 'chapter') {
      const built = buildChapter(entry);
      if (built) chaptersOut.push(built);
    } else if (entry.type === 'page') {
      const p = pagesById.get(entry.id);
      if (p) topPages.push({ ...p, chapter_id: null });
    }
  }
  return { chapters: chaptersOut, topPages };
}

// Flacht den bookTree-Output in Lesereihenfolge (kanonisch: Abschnitte ohne
// Kapitel zuerst, je Kapitel eigene Abschnitte vor den Unterkapiteln) zu
// { page, chapterId, chapterName, depth }-Records aus. chapterName ist das
// direkt umschliessende Kapitel; fuer Top-Level-Seiten null.
function flattenTree(tree) {
  const out = [];
  for (const p of (tree.topPages || [])) {
    out.push({ page: p, chapterId: null, chapterName: null, depth: 0 });
  }
  function walkChapters(chapters, depth) {
    for (const c of chapters) {
      for (const p of (c.pages || [])) {
        out.push({ page: p, chapterId: c.id, chapterName: c.name, depth });
      }
      walkChapters(c.subchapters || [], depth + 1);
    }
  }
  walkChapters(tree.chapters || [], 1);
  return out;
}

// Iteriert alle Kapitel des Trees (Top-Level + Sub-Kapitel rekursiv).
function walkAllChapters(tree, cb) {
  function walk(chapters, depth) {
    for (const c of chapters) {
      cb(c, depth);
      walk(c.subchapters || [], depth + 1);
    }
  }
  walk(tree.chapters || [], 1);
}

module.exports = { applyOrder, flattenTree, walkAllChapters, placeChapterAfter, spliceChapterOut };
