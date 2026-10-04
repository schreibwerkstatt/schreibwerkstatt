import { makeChatMethods } from './chat-base.js';
import { ideenProposalMethods } from './ideen-chat-proposals.js';

// Ideen-Chat-Methoden (gespreadet in die ideenBoardCard). Agentischer Chat NEBEN
// dem Ideen-Board: prüft Pendenzen gegen den Text, sucht Buch-Ideen einen Ort,
// räumt Dubletten auf und schlägt Verknüpfungen vor — jeder Vorschlag wird
// einzeln übernommen (ideen-chat-proposals.js).
// Jeder Provider (agentisch oder klassisch, serverseitig). Deep-Doc: docs/ideen-chat.md

/** Zusatz-State der Karte (Sessions/Verlauf/Lauf). */
export function ideenChatState() {
  return {
    ideenChatOpen: false,
    ideenChatSessions: [],
    ideenChatMessages: [],
    ideenChatSessionId: null,
    ideenChatInput: '',
    ideenChatLoading: false,
    ideenChatRunningSessionId: null,
    ideenChatProgress: 0,
    ideenChatStatus: '',
    _ideenChatPollTimer: null,
    _ideenChatGen: 0,
  };
}

export const ideenChatMethods = {
  async toggleIdeenChat() {
    this.ideenChatOpen = !this.ideenChatOpen;
    if (this.ideenChatOpen) {
      await this._onVisibleIdeenChat();
      this.$nextTick(() => this.$root?.querySelector('.ideen-chat-input')?.focus());
    }
  },

  // Schnellstart-Auftrag aus dem leeren Panel: füllt die Eingabe und schickt ab.
  async askIdeenChat(key) {
    if (this.ideenChatLoading) return;
    this.ideenChatInput = window.__app.t(key);
    await this.sendIdeenChatMessage();
  },

  // Kosten dieser Antwort (context_info.cost_usd, nur Cloud-Provider).
  ideenChatCostLabel(msg) {
    const usd = Number(msg?.context_info?.cost_usd);
    if (!Number.isFinite(usd) || usd <= 0) return '';
    const v = usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2);
    return window.__app.t('ideenBoard.chat.cost', { usd: v });
  },

  ...ideenProposalMethods,

  ...makeChatMethods({
    label: 'IdeenChat',
    props: {
      sessions: 'ideenChatSessions',
      messages: 'ideenChatMessages',
      sessionId: 'ideenChatSessionId',
      input: 'ideenChatInput',
      loading: 'ideenChatLoading',
      runningSessionId: 'ideenChatRunningSessionId',
      status: 'ideenChatStatus',
      progress: 'ideenChatProgress',
      pollTimer: '_ideenChatPollTimer',
      gen: '_ideenChatGen',
    },
    scrollElId: 'ideen-chat-messages',
    activeJobType: 'ideen-chat',
    canOpen: () => !!Alpine.store('nav').selectedBookId,
    sessionsUrl: () => '/chat/sessions/ideen/' + Alpine.store('nav').selectedBookId,
    newSessionUrl: '/chat/session/ideen',
    newSessionBody: () => ({ book_id: parseInt(Alpine.store('nav').selectedBookId) }),
    sendUrl: '/jobs/ideen-chat',
  }),
};
