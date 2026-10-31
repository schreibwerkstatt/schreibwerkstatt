// Alpine.data('chatCard') — Sub-Komponente des Seiten-Chats.
// Konversation über die aktuell offene Seite; jede Antwort läuft als Job über
// die Queue (/jobs/chat), die Karte pollt den Job (chat-base.js#startPollLocal).
//
// Eigener State: chatSessions, chatMessages, chatSessionId, chatInput,
//   chatLoading, chatRunningSessionId, chatProgress, chatStatus, _chatPollTimer,
//   _chatTitleTimer, _chatPendingRefresh, chatFlushFailed, _chatRetryOf.
// Geteilt über Alpine.store('pageChat'): die offenen Vorschläge als Inline-
//   Marken der Leseansicht (cards/page-chat-store.js).
// Root behält: showChatCard (Hash-Router), currentPage, originalHtml,
//   saveApplying, lektoratFindings, checkDone, _checkDoneBeforeChat,
//   _loadApplyAndSave, _applyTextReplacement, renameCurrentPage,
//   updatePageView, quickSave, _pullRemoteIntoEditor, _refetchCurrentPage,
//   cancelJob, canEdit, t.

import { chatMethods } from '../chat/chat.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { takeCardRequest, CARD_REQUEST } from './card-request.js';
import { EVT } from '../events.js';

export function registerChatCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('chatCard', () => ({
    chatSessions: [],
    chatMessages: [],
    chatSessionId: null,
    chatInput: '',
    chatLoading: false,
    // Session, für die der laufende Job arbeitet (null = kein Lauf).
    // Die Ladeanzeigen hängen daran, nicht an chatLoading — siehe chat-base.js.
    chatRunningSessionId: null,
    chatProgress: 0,
    chatStatus: '',
    _chatPollTimer: null,
    _chatTitleTimer: null,     // verzögerter Historien-Nachzug für den KI-Titel (chat.js#onPollDone)
    _chatGen: 0,               // Generationszähler gegen späte Responses nach Reset (chat-base.js)
    _hitMsgId: null,           // Treffer der Verlaufssuche: Sprungziel + Hervorhebung (chat-base.js)
    _chatPendingRefresh: false,
    // Flush vor dem Senden gescheitert → der Chat sieht den gespeicherten Stand
    // (Hinweis über dem Eingabefeld, chat.js#onBeforeSend).
    chatFlushFailed: false,
    // «Erneut fragen»: ID der ersetzten offenen Frage während des Sendens (chat.js).
    _chatRetryOf: null,
    // onShow ist durchgelaufen: ab dann holt der CARD_REQUEST-Listener einen
    // Session-Wunsch ab, vorher onShow selbst (sonst laden beide parallel).
    _chatShown: false,
    _lifecycle: null,

    init() {
      this._lifecycle = setupCardLifecycle(this, {
        showFlag: 'showChatCard',
        timerKeys: ['_chatPollTimer', '_chatTitleTimer'],
        onShow: async () => {
          // Seiten-Chat verbirgt die Lektorat-Findings, solange er offen ist;
          // app-view/cards.js#_setAside stellt checkDone aus dem Snapshot
          // wieder her, sobald die Leiste den Chat verlaesst. Nur hier: Buch- und Recherche-Chat liegen nicht neben
          // dem Editor und fassen den Lektorat-State nicht an.
          const root = window.__app;
          if (root?.currentPage) {
            root._checkDoneBeforeChat = root.checkDone;
            root.checkDone = false;
          }
          const requested = takeCardRequest(CARD_REQUEST.PAGE_CHAT_SESSION);
          const draft = takeCardRequest(CARD_REQUEST.PAGE_CHAT_DRAFT);
          this._chatShown = true;
          if (requested) await this._openRequestedChatSession(requested);
          else if (draft) await this._openChatDraft(draft);
          else await this._onVisibleChat();
          this.$nextTick(() => {
            const ta = this.$el?.querySelector('.chat-input');
            if (ta) ta.focus();
          });
        },
        // book:changed + view:reset reuse resetChat (kein einfaches resetState).
        onBookChanged: () => this.resetChat(),
        onViewReset: () => this.resetChat(),
        extraListeners: [
          { type: 'chat:reset', handler: () => this.resetChat() },
          { type: EVT.CARD_REQUEST, handler: (e) => {
            if (!this._chatShown) return;
            if (e.detail?.key === CARD_REQUEST.PAGE_CHAT_SESSION) {
              const id = takeCardRequest(CARD_REQUEST.PAGE_CHAT_SESSION);
              if (id) this._openRequestedChatSession(id);
            } else if (e.detail?.key === CARD_REQUEST.PAGE_CHAT_DRAFT) {
              const text = takeCardRequest(CARD_REQUEST.PAGE_CHAT_DRAFT);
              if (text) this._openChatDraft(text);
            }
          } },
        ],
      });
      // Karte zu → Inline-Marken + Stellen-Hervorhebung weg (page-view.js
      // zeigt Vorschläge nur bei offenem Seiten-Chat).
      this.$watch(() => window.__app?.showChatCard, (open) => {
        if (open) return;
        this._chatShown = false;
        this.unlocateChatVorschlag();
        window.__app?.updatePageView?.();
      });
      // Seitenstand gewechselt (Bearbeiten beendet/abgebrochen, gespeichert,
      // Remote-Stand übernommen, Fassung zurückgeholt) → Vorschlags-Zustände
      // neu prüfen: veraltet, wieder offen nach Rückgängig im Editor, …
      this.$watch(() => [window.__app?.originalHtml, window.__app?.editMode], () => {
        if (window.__app?.showChatCard && this.chatMessages.length) this._refreshVorschlagStates();
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    async _openRequestedChatSession(sessionId) {
      await this.loadChatSessions();
      await this.loadChatSession(sessionId);
    },

    // Vorformulierte Frage (Lektorat → «Im Chat besprechen»): neues Gespräch,
    // Text ins Eingabefeld, Cursor ans Ende — gesendet wird von Hand.
    async _openChatDraft(text) {
      await this.loadChatSessions();
      await this.startNewChatSession();
      this.chatInput = text;
      this.$nextTick(() => {
        const ta = this.$el?.querySelector('.chat-input');
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      });
    },

    // Im Edit-Modus ändert jeder Tastendruck den Stand, ohne dass ein Signal am
    // Root ankommt (Strg+Z inklusive) — geprüft wird, sobald der User zum Chat
    // wechselt, um dort zu handeln.
    onChatPointerEnter() {
      if (window.__app?.editMode && this.chatMessages.length) this._refreshVorschlagStates();
    },

    ...chatMethods,
  }));
}
