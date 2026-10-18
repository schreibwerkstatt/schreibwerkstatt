'use strict';
// Block-Merge auf dem Server beim Stale-Write (`PUT /content/pages/:id` mit
// `base_html`, Client-Vertrag: contract/README.md, docs/clients.md → «Sync»).
//
// Ein nativer Client, dessen Push wegen eines fremden Stands in 409 liefe,
// schickt die Basis mit, auf der er geschrieben hat. Der Server mergt dann
// selbst — mit derselben Engine wie Notebook, Bucheditor und der Mac-Client
// (public/js/editor/shared/block-merge.js, via lib/esm-bridge.js) — statt dass
// jeder Client den Merge ein drittes Mal nachbaut. Kollisionsfrei → der
// gemergte Stand wird geschrieben; echte Block-Kollision → der Client bekommt
// den gewohnten 409 und löst in seiner Konflikt-Ansicht auf.
//
// Geparst wird mit linkedom: der Regex-Fallback der Engine (für Node ohne
// DOMParser) trennt verschachtelte Blöcke gleichen Tags falsch.

const { DOMParser } = require('linkedom');
const { blockMerge } = require('./esm-bridge');

/**
 * Drei-Wege-Merge `base` → `local` gegen den aktuellen Server-Stand `remote`.
 * Liefert `{ html, conflicts }`: `html` ist nur bei `conflicts.length === 0`
 * zum Schreiben bestimmt; `conflicts` sind die `data-bid` der Blöcke, die beide
 * Seiten verschieden geändert haben.
 */
async function mergeAgainstServer({ baseHtml, localHtml, remoteHtml }) {
  const m = await blockMerge();
  const res = m.mergeBlocks(baseHtml, localHtml, remoteHtml, { DOMParser });
  return {
    html: m.mergedToHtml(res.merged),
    conflicts: res.conflicts.map((c) => c.bid),
  };
}

module.exports = { mergeAgainstServer };
