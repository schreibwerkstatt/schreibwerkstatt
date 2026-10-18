'use strict';
// Reihenfolge-Helfer fuer Importe.
//
// appendImportedTree: eine frisch angelegte Gliederung (Manuskript-Import) in
// book_order ans Ende des Buchs haengen — in genau der Reihenfolge, in der sie
// im Dokument stand.
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

/**
 * Kapitel mit Sortierschluessel innerhalb ihrer Geschwisterliste ordnen, ohne
 * die uebrigen Eintraege zu bewegen: die Kapitel mit Schluessel tauschen nur
 * untereinander ihre Plaetze (Ordner-Import: Jahres- und Monatskapitel
 * chronologisch, auch wenn ein Merge ein frueheres Jahr nachliefert).
 * @param {number} bookId
 * @param {Map<number, number>} keyById  chapter_id → Sortierschluessel
 */
function sortChapterSlots(bookId, keyById) {
  if (!keyById?.size) return;
  const ordered = bookOrder.ensureTree(bookId);
  let changed = false;
  const sortLevel = (ns) => {
    const slots = [];
    ns.forEach((n, i) => { if (n.type === 'chapter' && keyById.has(n.id)) slots.push(i); });
    const sorted = slots.map(i => ns[i]).sort((a, b) => keyById.get(a.id) - keyById.get(b.id));
    slots.forEach((slot, k) => { if (ns[slot] !== sorted[k]) changed = true; ns[slot] = sorted[k]; });
    for (const n of ns) if (n.type === 'chapter') sortLevel(n.children || (n.children = []));
  };
  const tree = JSON.parse(JSON.stringify(ordered?.tree || []));
  sortLevel(tree);
  if (changed) bookOrder.putOrder(bookId, tree, ordered?.updated_by ?? null);
}

module.exports = { appendImportedTree, sortChapterSlots };
