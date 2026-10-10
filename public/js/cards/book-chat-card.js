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
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showBookChatCard',
        timerKeys: ['_bookChatPollTimer'],
        onShow: async () => {
          await this._onVisibleBookChat();
          this.$nextTick(() => {
            const ta = this.$el?.querySelector('.chat-input');
            if (ta) ta.focus();
          });
        },
        onBookChanged: () => this.resetBookChat(),
        onViewReset: () => this.resetBookChat(),
        extraListeners: [{ type: 'book-chat:reset', handler: () => this.resetBookChat() }],
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...bookChatMethods,
  }));
}
