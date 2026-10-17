'use strict';
// Vorschautext-Cache (`pages.preview_text`) fuer das localdb-Backend.
// Ausgelagert, damit localdb.js unter dem LOC-Cap bleibt.
//
// preview_text ist ein abgeleiteter Cache (erste Zeichen des Seitentexts),
// kein Inhalt: der Schreibpfad fasst darum bewusst weder `updated_at` noch
// `local_updated_at` an und legt keine Revision an — sonst sähe jeder Sync
// wie eine Bearbeitung aus (Collab-Delta, „zuletzt geändert", Fassungen).

const { db } = require('../../../db/connection');

const _setPreviewStmt = db.prepare('UPDATE pages SET preview_text = ? WHERE page_id = ?');

const _setMany = db.transaction((items) => {
  for (const it of items) _setPreviewStmt.run(it.preview_text ?? null, it.page_id);
});

/**
 * Schreibt Vorschautexte in EINER Transaktion.
 * @param {Array<{page_id:number, preview_text:string|null}>} items
 * @returns {number} Anzahl uebergebener (gueltiger) Eintraege
 */
function setPagePreviews(items) {
  const valid = (items || []).filter(it => it && Number.isInteger(it.page_id));
  if (valid.length) _setMany(valid);
  return valid.length;
}

module.exports = { setPagePreviews };
