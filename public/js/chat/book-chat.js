import { makeChatMethods } from './chat-base.js';
import { fetchJson } from '../utils.js';
import { EVT } from '../events.js';
import { chatIdeeProposalMethods } from './chat-idee-proposals.js';

// Buch-Chat-Methoden (werden in Alpine.data('bookChatCard') gespreadet).
// Keine Textvorschläge – freie Konversation über das gesamte Buch (Agent-Flow);
// einzig Ideen-Vorschläge an einem Abschnitt (chat-idee-proposals.js).

// Werkzeug-Argumente als kurze Zeile für den ausklappbaren Werkzeug-Verlauf.
// Reiner Text — das Template bindet ihn per x-text (kein x-html).
export function formatToolInput(input, max = 160) {
  if (input == null) return '';
  let s;
  try { s = JSON.stringify(input); } catch { s = String(input); }
  if (s === '{}') return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// Zeilen des Werkzeug-Verlaufs: alle Tool-Calls ausser final_answer (das ist die
// Antwort selbst), mit Runde, Dauer, gekürzt/Fehler. `error` ist der Text fürs
// Modell (deutsch); hat das Werkzeug einen `errorKey` mitgeliefert, übersetzt `t`
// ihn für die Anzeige. Ohne Key bleibt der Rohtext (unerwartete Ausnahme).
export function toolRows(toolCalls, t = null) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .filter(tc => tc && tc.name !== 'final_answer')
    .map(tc => ({
      name: String(tc.name || ''),
      args: formatToolInput(tc.input),
      iter: tc.iter ?? null,
      durationMs: Number.isFinite(tc.durationMs) ? tc.durationMs : null,
      truncated: !!tc.truncated,
      failed: tc.ok === false,
      error: (tc.errorKey && t)
        ? t(tc.errorKey, tc.errorParams || {})
        : (tc.error ? String(tc.error).slice(0, 200) : ''),
    }));
}

export const bookChatMethods = {
  ...chatIdeeProposalMethods,

  _bookChatToolRows(msg) {
    return toolRows(msg?.context_info?.tool_calls, (k, p) => window.__app.t(k, p));
  },

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

  // Frage, die an den Recherche-Chat geht: vom Modell vorgeschlagen, sonst die
  // User-Frage, auf die diese Antwort reagiert.
  _bookChatResearchQuestion(msgIdx) {
    const msg = this.bookChatMessages[msgIdx];
    const proposed = (msg?.context_info?.recherche_frage || '').trim();
    if (proposed) return proposed;
    for (let i = msgIdx - 1; i >= 0; i--) {
      const m = this.bookChatMessages[i];
      if (m?.role === 'user') return String(m.content || '').trim();
    }
    return '';
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
    newSessionBody: (ctx) => ({
      book_id:   parseInt(Alpine.store('nav').selectedBookId),
      book_name: ctx.$app.selectedBookName,
    }),
    sendUrl: '/jobs/book-chat',
    onBeforeNewSession: async function () {
      await fetch('/jobs/book-chat-cache?book_id=' + Alpine.store('nav').selectedBookId, { method: 'DELETE' });
    },
  }),
};
