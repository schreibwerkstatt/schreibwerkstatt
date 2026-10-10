'use strict';
// Ideen-Vorschläge aus Abschnitts- und Buch-Chat: bemerkt das Modell beim
// Antworten einen Widerspruch, Fehler oder offenen Punkt, der sich nicht als
// Textersetzung lösen lässt, schlägt es vor, ihn als Idee (Pendenz) an einem
// Abschnitt oder Kapitel festzuhalten. Hier wird die Modellausgabe normalisiert und gegen
// das Buch geprüft — geschrieben wird NICHTS: der User erfasst jeden Vorschlag
// einzeln über POST /ideen (gleiche Validierung wie in der Ideen-Karte), der
// Status landet über PATCH /ideen/chat-proposal am Vorschlag.
//
// Gespeichertes Format (context_info.proposals[i]) — dieselbe Form wie das
// idee_create des Ideen-Chats (routes/jobs/ideen-chat-tools.js), damit der
// geteilte Status-Router (routes/chat-proposal-status.js) sie gleich behandelt:
//   { type: 'idee_create', fields: { content, page_id | chapter_id }, begruendung?,
//     labels: { anchor, anchor_kind: 'page'|'chapter' } }
//
// Anker ist ein Abschnitt ODER ein Kapitel des Session-Buchs (wie in der
// Ideen-Karte: höchstens einer). Auflösung:
//   - `ort: 'kapitel'` (Abschnitts-Chat): das genannte bzw. das Kapitel des
//     eigenen Abschnitts; hat der Abschnitt keins, der Abschnitt selbst.
//   - sonst `page_id` vor `chapter_id` (Buch-Chat; beide gesetzt → der Abschnitt
//     ist der genauere Ort), zuletzt der eigene Abschnitt (`defaultPageId`).
// Ein Vorschlag auf einen fremden oder unbekannten Ort fällt still heraus (kein
// Fehler für den User — die Antwort selbst bleibt gültig).

const { getPageWithChapter, getChapterRow } = require('../db/book-chat/text');

const MAX_PROPOSALS = 5;
const MAX_CONTENT = 4000; // = routes/ideen.js MAX_LEN
const MAX_BEGRUENDUNG = 600;

function _str(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function _int(v) {
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function _cached(cache, key, load) {
  if (!cache.has(key)) cache.set(key, load(key) || null);
  return cache.get(key);
}

/**
 * Anker eines Vorschlags → { kind: 'page'|'chapter', id, name } oder null.
 * Nur Orte im Buch `bookId`.
 */
function _resolveAnchor(item, { bookId, defaultPageId, pages, chapters }) {
  const page = (id) => {
    const r = id ? _cached(pages, id, getPageWithChapter) : null;
    return r && r.book_id === bookId ? r : null;
  };
  const chapter = (id) => {
    const r = id ? _cached(chapters, id, getChapterRow) : null;
    return r && r.book_id === bookId ? r : null;
  };
  const asPage = (r) => (r ? { kind: 'page', id: r.page_id, name: r.page_name } : null);
  const asChapter = (r) => (r ? { kind: 'chapter', id: r.chapter_id, name: r.chapter_name } : null);

  const pageId = _int(item.page_id);
  const chapterId = _int(item.chapter_id);
  if (item.ort === 'kapitel') {
    if (chapterId) return asChapter(chapter(chapterId));
    const own = page(pageId || defaultPageId);
    if (!own) return null;
    return asChapter(chapter(own.chapter_id)) || asPage(own);
  }
  if (pageId) return asPage(page(pageId));
  if (chapterId) return asChapter(chapter(chapterId));
  return asPage(page(defaultPageId));
}

/**
 * @param {unknown} raw  Modellfeld `ideen` (Array von { inhalt, begruendung?, page_id?, chapter_id?, ort? })
 * @param {{ bookId: number, defaultPageId?: number|null }} opts
 * @returns {Array<object>} normalisierte idee_create-Vorschläge (höchstens MAX_PROPOSALS)
 */
function normalizeChatIdeeProposals(raw, { bookId, defaultPageId = null } = {}) {
  if (!Array.isArray(raw) || !bookId) return [];
  const out = [];
  const seen = new Set();
  const ctx = { bookId, defaultPageId, pages: new Map(), chapters: new Map() };
  for (const item of raw) {
    if (out.length >= MAX_PROPOSALS) break;
    if (!item || typeof item !== 'object') continue;
    const content = _str(item.inhalt ?? item.content, MAX_CONTENT);
    if (!content) continue;
    const anchor = _resolveAnchor(item, ctx);
    if (!anchor) continue;
    const key = `${anchor.kind}:${anchor.id}\u0000${content.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const begruendung = _str(item.begruendung, MAX_BEGRUENDUNG);
    out.push({
      type: 'idee_create',
      fields: { content, [anchor.kind === 'page' ? 'page_id' : 'chapter_id']: anchor.id },
      ...(begruendung ? { begruendung } : {}),
      labels: { anchor: anchor.name || '', anchor_kind: anchor.kind },
    });
  }
  return out;
}

module.exports = { normalizeChatIdeeProposals, MAX_CHAT_IDEE_PROPOSALS: MAX_PROPOSALS };
