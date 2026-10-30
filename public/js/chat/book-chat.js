import { makeChatMethods } from './chat-base.js';
import { fetchJson } from '../utils.js';
import { EVT } from '../events.js';
import { chatIdeeProposalMethods } from './chat-idee-proposals.js';

// Buch-Chat-Methoden (werden in Alpine.data('bookChatCard') gespreadet).
// Keine Textvorschläge – freie Konversation über das gesamte Buch (Agent-Flow);
// einzig Ideen-Vorschläge an einem Abschnitt (chat-idee-proposals.js).

export const bookChatMethods = {
  ...chatIdeeProposalMethods,

  // Validierte Zitate aus final_answer (context_info.citations) als Fussnoten.
  bookChatCitations(msg) {
    const c = msg?.context_info?.citations;
    return Array.isArray(c) ? c : [];
  },

  // Kosten dieser Antwort (nur Claude; aus dem Job berechnet, context_info.cost_usd).
  _bookChatCost(msg) {
    const usd = msg?.context_info?.cost_usd;
    if (!(usd > 0)) return '';
    const v = usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2);
    return window.__app.t('chat.answerCost', { usd: v });
  },

  // Hinweis, wenn die Antwort aus einem Deckel-Abbruch synthetisiert wurde.
  _bookChatStopNote(msg) {
    const r = msg?.context_info?.stop_reason;
    if (r === 'input_cap') return window.__app.t('chat.stopInputCap');
    if (r === 'max_iter') return window.__app.t('chat.stopMaxIter');
    if (r === 'context_budget') return window.__app.t('chat.stopContextBudget');
    return '';
  },

  // Woher der Buchtext einer klassischen Antwort kam (context_info.retrievalMode
  // + Grund des Rückfalls), als eine Zeile: «Stichwortsuche – Index fehlt …».
  // Agentische Antworten zeigen das über ihren Werkzeug-Verlauf.
  _bookChatRetrievalNote(msg) {
    const ci = msg?.context_info;
    if (!ci || ci.mode === 'agent' || !ci.retrievalMode) return '';
    const t = (k, prm) => window.__app.t(k, prm);
    const mode = { full: 'full', semantic: 'semantic', keyword: 'keyword' }[ci.retrievalMode];
    if (!mode) return '';
    const parts = [t(`chat.retrieval.${mode}`)];
    const reason = ci.fullOverflow ? 'reasonFullOverflow' : ({
      disabled: 'reasonDisabled', no_index: 'reasonNoIndex', no_hits: 'reasonNoHits', error: 'reasonError',
    })[ci.retrievalFallback];
    if (mode !== 'full' && ci.fullRequested) parts.push(t('chat.retrieval.fullRequested'));
    if (mode !== 'full' && reason) parts.push(t(`chat.retrieval.${reason}`));
    if (ci.freshPages > 0) parts.push(t('chat.retrieval.freshPages', { n: ci.freshPages }));
    if (ci.historyTrimmed > 0) parts.push(t('chat.retrieval.historyTrimmed'));
    return parts.join(' – ');
  },

  // User-Frage, auf die die Antwort an `msgIdx` reagiert.
  _bookChatQuestionFor(msgIdx) {
    for (let i = msgIdx - 1; i >= 0; i--) {
      const m = this.bookChatMessages[i];
      if (m?.role === 'user') return String(m.content || '').trim();
    }
    return '';
  },

  // Frage, die an den Recherche-Chat geht: vom Modell vorgeschlagen, sonst die
  // User-Frage, auf die diese Antwort reagiert.
  _bookChatResearchQuestion(msgIdx) {
    const msg = this.bookChatMessages[msgIdx];
    const proposed = (msg?.context_info?.recherche_frage || '').trim();
    if (proposed) return proposed;
    return this._bookChatQuestionFor(msgIdx);
  },

  // Antwort brach an einem Deckel ab (input_cap/max_iter): dieselbe Frage als neuen
  // Lauf stellen (gleiche Deckel, frischer Werkzeug-Verlauf).
  _bookChatCanRetry(msg) {
    const r = msg?.context_info?.stop_reason;
    return r === 'input_cap' || r === 'max_iter';
  },
  // «Nochmals mit ganzem Buch» (POST `mode: 'full'` → klassischer Volltext-Lauf):
  // nur, wenn der Job gemessen hat, dass der Buchtext in den Kontext passt
  // (context_info.fullPossible), und die Antwort ihn nicht schon hatte — agentisch
  // nach einem Deckel-Abbruch, klassisch bei Auszügen statt Volltext.
  _bookChatCanRetryFull(msg) {
    const ci = msg?.context_info;
    if (!ci || ci.fullPossible !== true) return false;
    if (ci.mode === 'agent') return this._bookChatCanRetry(msg);
    return !!ci.retrievalMode && ci.retrievalMode !== 'full';
  },
  // `full`: dieselbe Frage mit `mode: 'full'` (sendExtra unten liest `_bookChatSendMode`).
  async retryBookChatQuestion(msgIdx, { full = false } = {}) {
    const q = this._bookChatQuestionFor(msgIdx);
    if (!q || this.bookChatLoading || this.isBookChatSessionActive(this.bookChatSessionId)) return;
    this.bookChatInput = q;
    this._bookChatSendMode = full ? 'full' : null;
    try { await this.sendBookChatMessage(); }
    finally { this._bookChatSendMode = null; }
  },

  // Frage an den Recherche-Chat übergeben. Schnittstelle: Window-Event
  // EVT.RESEARCH_CHAT_ASK, detail { question, bookId } (docs/chats.md „Übergabe
  // Buch-Chat → Recherche-Chat"). Der Empfänger (public/js/chat/research-chat-ask.js)
  // öffnet die Recherche-Karte samt Chat-Panel und belegt die Eingabe vor — gesendet
  // wird erst durch den User (Web-Suchen kosten). Darum hier kein eigenes Öffnen der
  // Karte: zwei Öffner liefen gegeneinander.
  askInResearchChat(msgIdx) {
    const bookId = parseInt(Alpine.store('nav').selectedBookId, 10);
    const question = this._bookChatResearchQuestion(msgIdx);
    if (!bookId || !question) return;
    window.dispatchEvent(new CustomEvent(EVT.RESEARCH_CHAT_ASK, { detail: { question, bookId } }));
  },

  // Laufende Antwort abbrechen. Die Job-ID kennt nur der Poller; /jobs/active
  // liefert sie für die laufende Session (Entity des Buch-Chat-Jobs = Session-ID),
  // abgebrochen wird über die Root-Mechanik (DELETE /jobs/:id). Das Poll-Ende
  // (Status 'cancelled') räumt den Lauf-State wie bei jedem Fehler.
  async cancelBookChatRun() {
    const sid = this.bookChatRunningSessionId;
    if (!sid) return;
    try {
      const active = await fetchJson(`/jobs/active?type=book-chat&book_id=${sid}`);
      if (active?.jobId) await window.__app.cancelJob(active.jobId);
    } catch (e) {
      console.error('[cancelBookChatRun]', e);
    }
  },

  ...makeChatMethods({
    label: 'BookChat',
    props: {
      sessions: 'bookChatSessions',
      messages: 'bookChatMessages',
      sessionId: 'bookChatSessionId',
      input: 'bookChatInput',
      loading: 'bookChatLoading',
      runningSessionId: 'bookChatRunningSessionId',
      status: 'bookChatStatus',
      progress: 'bookChatProgress',
      pollTimer: '_bookChatPollTimer',
      gen: '_bookChatGen',
    },
    scrollElId: 'book-chat-messages',
    activeJobType: 'book-chat',
    canOpen: (ctx) => !!Alpine.store('nav').selectedBookId,
    sessionsUrl: (ctx) => '/chat/sessions/book/' + Alpine.store('nav').selectedBookId,
    newSessionUrl: '/chat/session/book',
    newSessionBody: () => ({ book_id: parseInt(Alpine.store('nav').selectedBookId) }),
    sendUrl: '/jobs/book-chat',
    sendExtra: (ctx) => (ctx._bookChatSendMode === 'full' ? { mode: 'full' } : {}),
    onBeforeNewSession: async function () {
      await fetch('/jobs/book-chat-cache?book_id=' + Alpine.store('nav').selectedBookId, { method: 'DELETE' });
    },
  }),
};
