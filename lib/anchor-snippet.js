'use strict';
// Fundstellen-Snippets der Ist-Index-Jobs (motif-scan, beat-anchor, figur-anchor).
// Die Jobs speichern zu jeder Fundstelle einen kurzen Textauszug, den Karten und
// der Buch-Chat als „hier steht es" zeigen. Für Seiten-Treffer kommt der Auszug
// aus dem LIVE-Seitentext: der Index-Chunk kann hinter dem Seitenstand
// zurückliegen und ist nur Wegweiser, WO auf der Seite zu suchen ist
// (lib/live-passage.js). Steht die Stelle so nicht mehr auf der Seite, liefert
// `snippetFor` null — der Aufrufer verwirft den Treffer, statt einen Satz als
// Fundstelle abzulegen, der im Buch nicht mehr steht. Szenen-Treffer behalten
// ihren Chunk-Text (die Szenen-Zusammenfassung IST dort der Inhalt).
//
// Seitentexte werden pro Lauf einmal geladen (Cache im Closure): ein Motiv-Scan
// trifft dieselbe Seite für viele Motive.

const contentStore = require('./content-store');
const { htmlToPlainText } = require('./html-text');
const { bestLivePassage } = require('./live-passage');

const SNIPPET_MAX = 400;

const _TAG = /<\/?[^>]+>/g;
const _ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
function plainSnippet(s, max = SNIPPET_MAX) {
  return String(s || '').replace(_TAG, '').replace(/&(amp|lt|gt|quot|#39);/g, m => _ENT[m] || m).trim().slice(0, max);
}

/**
 * @param {number} bookId Buch des Laufs — Seiten anderer Bücher (verschoben) gelten als weg.
 * @returns {(hit: { kind: string, entity_id: number, text?: string }) => Promise<string|null>}
 */
function makeLiveSnippets(bookId, { maxChars = SNIPPET_MAX } = {}) {
  const pages = new Map();
  async function pageText(pageId) {
    const id = Number(pageId);
    if (!pages.has(id)) {
      const page = await contentStore.loadPage(id).catch(() => null);
      const ok = page && (bookId == null || Number(page.book_id) === Number(bookId));
      pages.set(id, ok ? htmlToPlainText(page.html || '') : null);
    }
    return pages.get(id);
  }
  return async function snippetFor(hit) {
    if (hit.kind !== 'page') return plainSnippet(hit.text, maxChars);
    const live = await pageText(hit.entity_id);
    if (!live) return null;
    const p = bestLivePassage(live, plainSnippet(hit.text, Infinity), { maxChars });
    return p ? p.text.replace(/\s+/g, ' ').trim() : null;
  };
}

module.exports = { plainSnippet, makeLiveSnippets, SNIPPET_MAX };
