'use strict';
// Ist ein gespeicherter Redundanz-Lauf (docs/redundanz.md) noch aktuell?
// Geteilt von Nacht-Lauf (routes/jobs/redundancy.js), Karte (routes/redundancy.js)
// und Chat-Werkzeug list_redundancies.
//
// Signal ist der Inhalt, nicht der Index-Stempel: der Nacht-Reindex setzt
// `indexedAt` bei jedem Lauf neu, auch ohne Änderung — daran gemessen wäre
// jeder Lauf am nächsten Morgen «veraltet».

const crypto = require('crypto');
const contentStore = require('./content-store');
const semanticChunks = require('../db/semantic-chunks');
const { listFigureNamesForUser } = require('../db/book-chat/figures');

/** Hash über Abschnitte (ID + Änderungsstempel) und die Figuren-IDs des Users. */
async function contentSig(bookId, userEmail) {
  const pages = (await contentStore.listPages(bookId)).map(p => `${p.id}:${p.updated_at || ''}`).sort();
  const figs = listFigureNamesForUser(bookId, userEmail).map(f => f.id).sort((a, b) => a - b);
  return crypto.createHash('sha1').update(pages.join(',') + '|' + figs.join(',')).digest('hex');
}

/** true = seit dem Lauf haben sich Text, Figuren oder das Modell geändert.
 *  Läufe ohne Signatur (älter als das Feld) fallen auf den Index-Vergleich zurück. */
async function isRunStale(bookId, userEmail, run, model) {
  if (!run) return false;
  if (run.contentSig) return (!!model && run.model !== model) || run.contentSig !== await contentSig(bookId, userEmail);
  const last = run.model ? semanticChunks.lastIndexedAt(bookId, run.model) : null;
  return !!(run.indexedAt && last && last > run.indexedAt);
}

module.exports = { contentSig, isRunStale };
