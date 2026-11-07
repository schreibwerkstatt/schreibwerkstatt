'use strict';
// Index der URLs, die der Recherche-Chat in DIESEM Lauf kennt: Web-Treffer,
// gelesene Seiten samt Redirect-Ziel, Literatur-Treffer, Links der User-Nachricht
// und die URLs der Archiv-Einträge des Buchs. Eine Normalisierung
// (lib/url-normalize), ein Index für beide Fragen:
//   - darf read_web_page diese URL holen, und welchen GESPEICHERTEN String?
//     (research-web-tools.js#_knownUrl)
//   - ist eine Vorschlags-URL in diesem Lauf belegt? (research-chat-helpers.js#markProposalUrls)
//
// Inkrementell: die Quell-Listen wachsen nur (append-only), der Index nimmt je
// Aufruf nur die neuen Einträge auf. Die Archiv-URLs liest er einmal je Lauf —
// nicht bei jedem Seitenabruf neu. Bei gleicher Normalform gewinnt die zuerst
// gesehene Fassung, Archiv-URLs stehen hinter allem aus dem Lauf.

const { normalizeUrl } = require('../../lib/url-normalize');
const { bookItemUrls } = require('../../db/research-items');

const _urlOf = (u) => (typeof u === 'string' ? u : u?.url);

/**
 * @param {object} ctx  Lauf-Kontext ({ web?: {results, pages}, literatureHits, userMessageUrls, bookId });
 *                      der Index hängt als ctx.urlIndex daran.
 * @param {{ webResults?: Array }} [extra]  Treffer des serverseitigen web_search (Loop), Suchweg Anthropic
 * @returns {Map<string,string>} Normalform → gespeicherte URL
 */
function syncUrlIndex(ctx, { webResults = null } = {}) {
  if (!ctx.urlIndex) ctx.urlIndex = { map: new Map(), seen: new Map(), book: false };
  const idx = ctx.urlIndex;
  const add = (u) => {
    const raw = _urlOf(u);
    const n = normalizeUrl(raw);
    if (n && !idx.map.has(n)) idx.map.set(n, raw);
  };
  const lists = [
    ['loop', webResults],
    ['results', ctx.web?.results],
    ['pages', ctx.web?.pages],
    ['literature', ctx.literatureHits],
    ['user', ctx.userMessageUrls],
    // Geprüfte Quellen früherer Antworten dieser Session (research-chat-helpers.js#sessionPriorSources).
    ['prior', ctx.priorSources],
  ];
  for (const [key, list] of lists) {
    if (!Array.isArray(list)) continue;
    const from = idx.seen.get(key) || 0;
    for (let i = from; i < list.length; i++) add(list[i]);
    idx.seen.set(key, list.length);
  }
  if (!idx.book && ctx.bookId) {
    bookItemUrls(ctx.bookId).forEach(add);
    idx.book = true;
  }
  return idx.map;
}

/** Gespeicherte URL bekannter Herkunft zur (Modell-)URL, sonst null. */
function lookupKnownUrl(url, ctx) {
  const n = normalizeUrl(url);
  if (!n) return null;
  return syncUrlIndex(ctx).get(n) || null;
}

module.exports = { syncUrlIndex, lookupKnownUrl };
