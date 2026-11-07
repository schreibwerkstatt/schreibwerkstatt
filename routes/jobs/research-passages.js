'use strict';
// Manuskriptstellen, die einem Recherche-Fundstück inhaltlich am nächsten
// stehen — als LIVE-Ausschnitt. Geteilt von den Seiten-Vorschlägen des
// Verknüpfungs-Jobs (./research-link.js) und dem Rückfall des Recherche-Abgleichs
// (./research-crosscheck.js), damit beide dieselbe Auswahl treffen.
//
// Die Embedding-Treffer (lib/research-retrieval.js) sind nur Wegweiser: der
// Index kann hinter dem Seitenstand liegen. Der Ausschnitt kommt darum aus dem
// aktuellen Seitentext (lib/live-passage.js); steht die Chunk-Stelle dort nicht
// mehr (umgeschrieben/gelöscht), fällt die Seite weg — ein unverwandter Absatz
// wäre kein Beleg. Je Seite höchstens eine Stelle; fremde Bücher fallen weg.

const contentStore = require('../../lib/content-store');
// Über das Modul-Objekt, damit Tests den Embedding-Zugriff ersetzen können.
const retrieval = require('../../lib/research-retrieval');
const { bestLivePassage } = require('../../lib/live-passage');
const { htmlToTextForPrompt } = require('./shared');

/**
 * @param {number} bookId
 * @param {object} item     Fundstück ({ id, title, body, doc_text })
 * @param {{ limit: number, topK: number, maxChars: number, signal?: AbortSignal }} opts
 * @returns {Promise<Array<{ page_id: number, page_name: string, text: string }>>}
 *   Wirft, wenn die Embedding-Suche ausfällt (Aufrufer entscheidet, was das heisst).
 */
async function semanticLivePassages(bookId, item, { limit, topK, maxChars, signal }) {
  const hits = await retrieval.researchPageHits(bookId, item, { topK, signal });
  const out = [];
  const seen = new Set();
  for (const h of hits) {
    if (h.kind !== 'page' || seen.has(h.entity_id) || !h.text) continue;
    seen.add(h.entity_id);
    const page = await contentStore.loadPage(h.entity_id).catch(() => null);
    if (!page || page.book_id !== bookId) continue;
    const live = bestLivePassage(htmlToTextForPrompt(page.html || ''), h.text, { maxChars });
    if (!live || !live.text) continue;
    out.push({ page_id: h.entity_id, page_name: page.name || '', text: live.text });
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { semanticLivePassages };
