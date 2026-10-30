// Buch-Chat (Frontend): Herkunft des Kontexts einer klassischen Antwort als eine
// Zeile (context_info.retrievalMode/-Fallback/fullOverflow/freshPages/historyTrimmed)
// und «Erneut fragen» nach einem Deckel-Abbruch.
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = globalThis.window || {};
globalThis.window.addEventListener = globalThis.window.addEventListener || (() => {});
globalThis.window.removeEventListener = globalThis.window.removeEventListener || (() => {});
globalThis.window.__app = { t: (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k) };
const { bookChatMethods: m } = await import('../../public/js/chat/book-chat.js');

const note = (ci) => m._bookChatRetrievalNote({ role: 'assistant', context_info: ci });

test('Retrieval-Notiz: Modus + Rückfallgrund, Volltext ohne Grund, agentisch leer', () => {
  assert.equal(note({ retrievalMode: 'full' }), 'chat.retrieval.full');
  assert.equal(note({ retrievalMode: 'keyword', retrievalFallback: 'no_index' }), 'chat.retrieval.keyword – chat.retrieval.reasonNoIndex');
  assert.equal(note({ retrievalMode: 'keyword', retrievalFallback: 'disabled', fullOverflow: true }),
    'chat.retrieval.keyword – chat.retrieval.reasonFullOverflow');
  assert.equal(note({ retrievalMode: 'semantic', freshPages: 2, historyTrimmed: 4 }),
    'chat.retrieval.semantic – chat.retrieval.freshPages:{"n":2} – chat.retrieval.historyTrimmed');
  assert.equal(note({ mode: 'agent', tool_calls: [] }), '');
  assert.equal(note(null), '');
});

test('Erneut fragen: nur nach input_cap/max_iter, sendet die Frage der Runde', async () => {
  assert.equal(m._bookChatCanRetry({ context_info: { stop_reason: 'input_cap' } }), true);
  assert.equal(m._bookChatCanRetry({ context_info: { stop_reason: 'max_iter' } }), true);
  assert.equal(m._bookChatCanRetry({ context_info: { stop_reason: 'context_budget' } }), false);
  let sent = null;
  const card = {
    ...m,
    bookChatMessages: [{ role: 'user', content: 'Wer ist Anna?' }, { role: 'assistant', content: 'x', context_info: { stop_reason: 'max_iter' } }],
    bookChatLoading: false, bookChatSessionId: 5, bookChatInput: '',
    isBookChatSessionActive: () => false,
    sendBookChatMessage() { sent = this.bookChatInput; },
  };
  await card.retryBookChatQuestion(1);
  assert.equal(sent, 'Wer ist Anna?');
  sent = null;
  card.isBookChatSessionActive = () => true;
  await card.retryBookChatQuestion(1);
  assert.equal(sent, null, 'kein zweiter Lauf, wenn die Session schon läuft');
});
