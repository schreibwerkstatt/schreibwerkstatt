'use strict';
// search_chat_history — frühere Gespräche des Users zu diesem Buch (Buch- und
// Abschnitts-Chats) nach Wortlaut + Bedeutung, über dieselbe Pipeline wie die
// Verlaufssuche der Chat-Karten (lib/chat-search.js). Scope: ctx.bookId +
// ctx.userEmail; das laufende Gespräch (ctx.sessionId) ist ausgenommen — es steht
// ohnehin im Kontext. Ohne Embedding-Endpunkt bleibt die Wortlaut-Suche.

const { searchChatHistory } = require('../../../lib/chat-search');

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const SNIPPET_CHARS = 400;

async function tool_search_chat_history(input, ctx) {
  const query = String(input.query || '').trim();
  if (!query) return { error: 'query fehlt', errorKey: 'chat.toolError.missingParam', errorParams: { param: 'query' } };
  if (!ctx.userEmail) return { query, count: 0, results: [] };
  const scope = input.scope === 'book' || input.scope === 'page' ? input.scope : 'all';
  const limit = Math.min(Math.max(1, Number.isInteger(input.limit) ? input.limit : DEFAULT_LIMIT), MAX_LIMIT);

  const r = await searchChatHistory({
    bookId: ctx.bookId, userEmail: ctx.userEmail, query,
    kinds: scope === 'all' ? ['book', 'page'] : [scope],
    excludeSessionId: ctx.sessionId || null, limit, signal: ctx.jobSignal,
  });
  const results = r.hits.map(h => ({
    session_id: h.session_id,
    kind: h.kind,
    ...(h.page_name ? { page_name: h.page_name } : {}),
    title: h.title,
    created_at: h.created_at,
    snippet: h.plain.length > SNIPPET_CHARS ? h.plain.slice(0, SNIPPET_CHARS) + '…' : h.plain,
  }));
  return { query, count: results.length, results };
}

module.exports = { tool_search_chat_history };
