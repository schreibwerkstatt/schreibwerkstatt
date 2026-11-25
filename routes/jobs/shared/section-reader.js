'use strict';
// Abschnitts-Leser: EIN Weg, auf dem ein KI-Pfad Abschnitte samt Struktur holt.
//
// Liefert je Abschnitt Text und Ort im Buch — nichts Fachliches. Figuren, Ideen,
// Welt-Fakten, Bewertungen laden die Chats und Jobs über ihre eigenen Loader
// (getFiguren, getOpenIdeen, listWorldFacts, review-context …), weil jeder sie
// anders auswählt und budgetiert.
//
//   text     Prompt-Text mit Absätzen (book-text-format.js#pageTextForAi) — die Form,
//            die das Modell sieht. Formatieren für den Prompt: book-text-format.js.
//   compare  (opt.) einzeilige Vergleichsform (htmlToText) für Abgleiche gegen
//            gespeicherte Stände; sie ist kein Prompt-Text.
//
// Auswahl: `pageIds` (Reihenfolge der Eingabe, fremde/fehlende → `missing`),
// `chapterId` (+ `includeSubchapters`, Lesereihenfolge) oder `all` (ganzes Buch in
// Lesereihenfolge). Der Buch-Scope folgt aus der Gliederung: eine ID, die nicht im
// Buch steht, wird nie geladen.
//
// Die Buch-Jobs mit Single-/Multi-Pass lesen über loader.js#loadPageContents
// (Vorfilter über preview_text, Gruppen für die Chunks) — dieselbe Textfunktion.

const contentStore = require('../../../lib/content-store');
const { getBookSettings } = require('../../../db/schema');
const { pageTextForAi } = require('./book-text-format');

// Text-Optionen fuer htmlToText/htmlToTextForPrompt/loadPageContents eines Jobs
// mit Buch: Nachrichtenverlauf-Marken in der Buchsprache (lib/html-text.js
// #markMsgThreads), damit ein englisches Buch keine deutschen Marken im Prompt
// traegt. Ohne Buch Deutsch, wie die Marken selbst.
function bookTextOpts(bookId, userEmail = null) {
  if (!bookId) return { langCode: 'de' };
  return { langCode: getBookSettings(bookId, userEmail).language || 'de' };
}

/**
 * @param {number} bookId
 * @param {object} opts
 * @param {number[]} [opts.pageIds]
 * @param {number} [opts.chapterId]
 * @param {boolean} [opts.includeSubchapters=true]
 * @param {boolean} [opts.all]
 * @param {string|null} [opts.userEmail]  Buch-Einstellungen (Sprache) des Users
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.keepHtml]  `html` mitliefern
 * @param {boolean} [opts.withCompare]  `compare` mitliefern
 * @param {Array} [opts.outline]  bereits geladene Gliederung (spart eine Abfrage)
 * @returns {Promise<{ sections: Array<{ id, title, chapterId, chapterPath, chapterName, depth,
 *   slug, bookSlug, updatedAt, text, compare?, html? }>, missing: Array<{ page_id, error, status? }>,
 *   outline: Array }>}
 */
async function readSections(bookId, {
  pageIds = null, chapterId = null, includeSubchapters = true, all = false,
  userEmail = null, signal = null, keepHtml = false, withCompare = false, outline = null,
} = {}) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const ol = outline || await contentStore.bookOutline(bookId);
  const pageNodes = ol.filter(n => n.type === 'page');
  const missing = [];
  let rows;
  if (Array.isArray(pageIds)) {
    const byId = new Map(pageNodes.map(n => [n.id, n]));
    rows = [];
    for (const id of pageIds) {
      const n = byId.get(id);
      if (n) rows.push(n);
      else missing.push({ page_id: id, error: 'Abschnitt nicht im aktuellen Buch.' });
    }
  } else if (chapterId != null) {
    rows = contentStore.chapterPages(ol, chapterId, { includeSubchapters });
  } else if (all) {
    rows = pageNodes;
  } else {
    throw new Error('readSections: pageIds, chapterId oder all angeben');
  }
  if (!rows.length) return { sections: [], missing, outline: ol };

  const loaded = await contentStore.loadPagesBatch(rows.map(r => ({ id: r.id })), null, {
    onError: (meta, e) => { missing.push({ page_id: meta.id, error: e.message, ...(e.status ? { status: e.status } : {}) }); return null; },
  });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const nodeById = new Map(rows.map(r => [r.id, r]));
  const textOpts = bookTextOpts(bookId, userEmail);
  const { htmlToText } = withCompare ? require('./ai') : {};
  const sections = loaded.map(pd => {
    const node = nodeById.get(pd.id) || {};
    const html = pd.html || '';
    return {
      id: pd.id,
      title: pd.name || node.name || `#${pd.id}`,
      chapterId: pd.chapter_id ?? node.chapter_id ?? null,
      chapterPath: contentStore.formatChapterPath(node.path),
      chapterName: Array.isArray(node.path) && node.path.length ? node.path[node.path.length - 1] : null,
      depth: node.depth ?? 0,
      slug: pd.slug || null,
      bookSlug: pd.book_slug || null,
      updatedAt: pd.updated_at || '',
      text: pageTextForAi(html, textOpts),
      ...(withCompare ? { compare: htmlToText(html, textOpts) } : {}),
      ...(keepHtml ? { html } : {}),
    };
  });
  return { sections, missing, outline: ol };
}

module.exports = { readSections, bookTextOpts };
