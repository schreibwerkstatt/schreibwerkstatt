'use strict';
// Welt-Fakten nach Phase 1 persistieren — ausgelagert aus job-komplett.js (LOC-Cap).
const { saveFaktenToDb } = require('../../../db/schema');

/** Ein ausgefallener Fakten-Pass ersetzt den Index nicht mit [] (`ctx.faktenFailure`
 *  aus Phase 1): ganz ausgefallen → bestehende Fakten bleiben; einzelne Kapitel
 *  ausgefallen → nur diese behalten ihre bisherigen Fakten (saveFaktenToDb keepChapterIds). */
function persistWorldFacts(ctx, chapterFakten, chNameToId) {
  const { bookIdInt, email, log } = ctx;
  const failure = ctx.faktenFailure;
  if (failure?.all) {
    log.warn('Welt-Fakten nicht ersetzt: Fakten-Pass ausgefallen, bestehender Index bleibt.');
    return;
  }
  const keepChapterIds = new Set((failure?.kapitel || [])
    .map(n => chNameToId?.[n]).filter(id => id != null));
  const { count } = saveFaktenToDb(bookIdInt, chapterFakten, email, chNameToId, { keepChapterIds });
  log.info(`${count} Welt-Fakten gespeichert${keepChapterIds.size ? ` (${keepChapterIds.size} Kapitel mit bisherigen Fakten)` : ''}.`);
}

module.exports = { persistWorldFacts };
