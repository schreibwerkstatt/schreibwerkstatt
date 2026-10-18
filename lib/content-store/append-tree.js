'use strict';
// Eine frisch angelegte Gliederung (Manuskript-Import) in book_order ans Ende
// des Buchs haengen — in genau der Reihenfolge, in der sie im Dokument stand.
// Ohne diesen Schritt rekonstruiert ensureTree die Reihenfolge aus
// chapters.position/pages.position: Kapitel zaehlen dort pro Geschwisterliste,
// Abschnitte buchweit, und ein Kapitel schlaegt bei gleicher Position den
// Abschnitt — ein Vorwort landet so hinter Kapitel 1, eine Kapiteleinleitung
// hinter den Unterkapiteln.

const bookOrder = require('../../db/book-order');

/**
 * @param {number} bookId
 * @param {Array<{type:'chapter',id:number,children:Array}|{type:'page',id:number}>} nodes
 *   Neu angelegte Knoten in Dokument-Reihenfolge (ids existieren bereits).
 */
function appendImportedTree(bookId, nodes) {
  if (!Array.isArray(nodes) || !nodes.length) return;
  const ids = { chapter: new Set(), page: new Set() };
  (function collect(ns) {
    for (const n of ns) {
      ids[n.type].add(n.id);
      if (n.children) collect(n.children);
    }
  })(nodes);
  const ordered = bookOrder.ensureTree(bookId);
  const strip = (ns) => ns
    .filter(n => !ids[n.type]?.has(n.id))
    .map(n => (n.type === 'chapter' ? { ...n, children: strip(n.children || []) } : n));
  // updated_by bleibt beim letzten echten Umsortierer — Anlegen ist kein Reorder.
  bookOrder.putOrder(bookId, [...strip(ordered?.tree || []), ...nodes], ordered?.updated_by ?? null);
}

module.exports = { appendImportedTree };
