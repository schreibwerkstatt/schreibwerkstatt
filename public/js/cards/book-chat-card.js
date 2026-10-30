// Alpine.data('bookChatCard') — Sub-Komponente des Buch-Chats.
// Freie Konversation über das gesamte Buch (Agent mit Tool-Use).
//
// Eigener State: bookChatSessions, bookChatMessages, bookChatSessionId,
//   bookChatInput, bookChatLoading, bookChatRunningSessionId,
//   bookChatProgress, bookChatStatus,
//   _bookChatPollTimer.
// Root behält: showBookChatCard (Hash-Router), selectedBookId,
//   selectedBookName, t.

import { bookChatMethods } from '../chat/book-chat.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { takeCardRequest, CARD_REQUEST } from './card-request.js';
import { EVT } from '../events.js';

export function registerBookChatCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('bookChatCard', () => ({
    bookChatSessions: [],
    bookChatMessages: [],
    bookChatSessionId: null,
    bookChatInput: '',
    bookChatLoading: false,
    // Session, für die der laufende Job arbeitet (null = kein Lauf).
    bookChatRunningSessionId: null,
    bookChatProgress: 0,
    bookChatStatus: '',
    _bookChatPollTimer: null,
    _bookChatGen: 0,           // Generationszähler gegen späte Responses nach Reset (chat-base.js)
    _hitMsgId: null,           // Treffer der Verlaufssuche: Sprungziel + Hervorhebung (chat-base.js)
    // onShow ist durchgelaufen: ab dann holt der CARD_REQUEST-Listener einen
    // Entwurf ab, vorher onShow selbst (sonst laden beide parallel).
    _bookChatShown: false,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showBookChatCard',
        timerKeys: ['_bookChatPollTimer'],
        onShow: async () => {
          const draft = takeCardRequest(CARD_REQUEST.BOOK_CHAT_DRAFT);
          this._bookChatShown = true;
          if (draft) return this._openBookChatDraft(draft);
          await this._onVisibleBookChat();
          this.$nextTick(() => {
            const ta = this.$el?.querySelector('.chat-input');
            if (ta) ta.focus();
          });
        },
        onBookChanged: () => this.resetBookChat(),
        onViewReset: () => this.resetBookChat(),
        extraListeners: [
          { type: 'book-chat:reset', handler: () => this.resetBookChat() },
          { type: EVT.CARD_REQUEST, handler: (e) => {
            if (e.detail?.key !== CARD_REQUEST.BOOK_CHAT_DRAFT || !this._bookChatShown) return;
            const text = takeCardRequest(CARD_REQUEST.BOOK_CHAT_DRAFT);
            if (text) this._openBookChatDraft(text);
          } },
        ],
      });
      this.$watch(() => window.__app?.showBookChatCard, (open) => { if (!open) this._bookChatShown = false; });
    },

    // Vorformulierte Frage (Übersicht → «Nächste Schritte»): neues Gespräch,
    // Text ins Eingabefeld, Cursor ans Ende — gesendet wird von Hand.
    async _openBookChatDraft(text) {
      await this.loadBookChatSessions();
      await this.startNewBookChatSession();
      this.bookChatInput = text;
      this.$nextTick(() => {
        const ta = this.$el?.querySelector('.chat-input');
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...bookChatMethods,
  }));
}
