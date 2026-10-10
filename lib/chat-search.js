'use strict';
// Suche im Chat-Verlauf (docs/chats.md#suche-im-verlauf): Wortlaut (FTS5) und
// Bedeutung (Embeddings) über die eigenen Gespräche eines Users in einem Buch,
// per Reciprocal Rank Fusion zu einer Liste gemischt. Konsumenten: die
// Verlaufssuche von Abschnitts- und Buch-Chat (GET /chat/search/:book_id) und
// das Buch-Chat-Werkzeug `search_chat_history`.
//
// Einheit der Trefferliste ist die Gesprächs-RUNDE (Frage + Antwort): ein
// Wortlaut-Treffer in der Frage und ein Bedeutungs-Treffer in der Antwort
// derselben Runde sind EIN Treffer. Ohne Embedding-Endpunkt (oder wenn er
// ausfällt) bleibt die Wortlaut-Suche — sie hängt an keinem externen Dienst.

const chatSearchDb = require('../db/chat-search');
const { buildMatchQuery } = require('./search');
const { fuseCandidates } = require('./semantic-fusion');
const embed = require('./embed');
const appSettings = require('./app-settings');
const logger = require('../logger');

const SNIPPET_CHARS = 240;

function _minScore() {
  const v = Number(appSettings.get('embed.min_score'));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

const _HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const _esc = (s) => String(s).replace(/[&<>"']/g, (c) => _HTML_ESC[c]);

// Markdown-Auszeichnung, die im Ausschnitt nur stört (Chat-Antworten sind
// Markdown): Fett/Kursiv-Klammern, Code-Ticks, Überschriften-Rauten.
function _plain(s) {
  return String(s || '')
    .replace(/\*\*|__|`+/g, '')
    .replace(/(^|\s)#{1,6}\s/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Jedes einzelne Wort als Präfix suchen («Lena» findet «Lenas», ein angefangenes
// Wort findet das ganze) — Phrasen und Negationen bleiben exakt. Basis ist die
// Syntax-sichere Übersetzung der Buchsuche (lib/search.js#buildMatchQuery).
function _matchQuery(q) {
  return buildMatchQuery(q).replace(/(^|\s)("[^"\s]+")(?!\*)(?=\s|$)/g, '$1$2*');
}

// FTS-Snippet → HTML: erst escapen, dann die Sentinels zu <mark>. Reihenfolge
// zwingend (sonst würden eingeschleuste <mark> mitescaped bzw. Inhalt nicht).
function _ftsSnippetHtml(raw) {
  return _esc(_plain(raw))
    .split(chatSearchDb.SNIP_OPEN).join('<mark>')
    .split(chatSearchDb.SNIP_CLOSE).join('</mark>');
}

// Ausschnitt eines Bedeutungs-Treffers: Chunk-Anfang, gekappt, escaped.
function _chunkSnippetHtml(text) {
  const t = _plain(text);
  return _esc(t.length > SNIPPET_CHARS ? t.slice(0, SNIPPET_CHARS).trimEnd() + '…' : t);
}

/**
 * @param {object} p
 * @param {number} p.bookId
 * @param {string} p.userEmail
 * @param {string} p.query
 * @param {string[]} [p.kinds]           Session-Arten ('page','book'), Default beide
 * @param {number|null} [p.pageId]       nur Gespräche dieses Abschnitts
 * @param {number|null} [p.excludeSessionId] laufendes Gespräch ausnehmen (Werkzeug)
 * @param {number} [p.limit]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<{hits: object[], semantic: boolean, semanticError: boolean, pending: number}>}
 *   hits: [{ message_id, round_id, session_id, kind, page_id, page_name, title,
 *   created_at, snippet (HTML, escaped), plain (Klartext), match: 'text'|'meaning'|'both' }]
 *   `message_id` ist das Sprungziel (die gefundene Nachricht, bei reinen
 *   Bedeutungs-Treffern die Antwort der Runde). `pending` = Runden ohne Vektor.
 */
async function searchChatHistory({
  bookId, userEmail, query, kinds = chatSearchDb.SEARCHABLE_KINDS,
  pageId = null, excludeSessionId = null, limit = 30, signal,
} = {}) {
  const scope = { bookId, userEmail, kinds, pageId, excludeSessionId };
  const q = String(query || '').trim();
  const out = { hits: [], semantic: false, semanticError: false, pending: 0 };
  if (!q || !bookId || !userEmail) return out;
  const pool = Math.max(limit * 2, 40);

  const fts = chatSearchDb.ftsSearch(_matchQuery(q), scope, { limit: pool });

  let sem = [];
  if (embed.isEnabled()) {
    const { model, dim } = embed.getConfig();
    out.semantic = true;
    out.pending = chatSearchDb.countUnindexedRounds(bookId, model);
    try {
      const qvec = await embed.embedQuery(q, { signal });
      if (qvec.length === dim) {
        sem = chatSearchDb.semanticSearch(scope, model, qvec, { topK: pool, minScore: _minScore() });
      }
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      out.semanticError = true;
      logger.warn(`Chat-Verlaufssuche: Embedding fehlgeschlagen, nur Wortlaut (Buch ${bookId}): ${e.message}`);
    }
  }

  // Schlüssel der Runde. Eine User-Nachricht ohne Antwort ist ihre eigene Runde.
  const keyOf = (roundId, messageId) => (roundId != null ? `r${roundId}` : `m${messageId}`);
  const ftsByKey = new Map();
  for (const h of fts) {
    const k = keyOf(h.round_id, h.message_id);
    if (!ftsByKey.has(k)) ftsByKey.set(k, h); // bester (erster) Wortlaut-Treffer je Runde
  }
  const semByKey = new Map(sem.map(h => [keyOf(h.round_id), h]));

  const fused = fuseCandidates(
    sem.map(h => ({ kind: 'chat', entity_id: keyOf(h.round_id), chunk_ix: null, text: h.text, score: h.score })),
    [...ftsByKey.keys()].map(k => ({ kind: 'chat', entity_id: k })),
  ).slice(0, limit);

  const targets = fused.map(c => {
    const f = ftsByKey.get(c.entity_id);
    const s = semByKey.get(c.entity_id);
    return { key: c.entity_id, f, s, messageId: f ? f.message_id : s.round_id };
  });
  const meta = chatSearchDb.messageMeta(targets.map(t => t.messageId), scope);

  for (const t of targets) {
    const m = meta.get(t.messageId);
    if (!m) continue;
    out.hits.push({
      message_id: t.messageId,
      round_id: t.f ? t.f.round_id : t.s.round_id,
      session_id: m.session_id,
      kind: m.kind,
      page_id: m.page_id,
      page_name: m.page_name,
      title: m.title || _plain(m.preview).slice(0, 80),
      created_at: m.created_at,
      snippet: t.f ? _ftsSnippetHtml(t.f.snippet) : _chunkSnippetHtml(t.s.text),
      plain: t.f
        ? _plain(t.f.snippet).split(chatSearchDb.SNIP_OPEN).join('').split(chatSearchDb.SNIP_CLOSE).join('')
        : _plain(t.s.text),
      match: t.f && t.s ? 'both' : (t.f ? 'text' : 'meaning'),
    });
  }
  return out;
}

module.exports = { searchChatHistory, _matchQuery };
