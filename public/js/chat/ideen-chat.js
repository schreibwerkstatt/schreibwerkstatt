import { makeChatMethods } from './chat-base.js';
import { ideenProposalMethods } from './ideen-chat-proposals.js';
import { IDEEN_CHECK_MIN, openAnchoredIdeenCount } from '../book/ideen-shared.js';

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

  // Feature-Tipp «Was ist schon erledigt?» (ideen-board.html): Panel öffnen und
  // den Erledigt-Check in einem neuen Gespräch starten.
  async startIdeenErledigtCheck() {
    if (!this.ideenChatOpen) await this.toggleIdeenChat();
    await this.startNewIdeenChatSession();
    await this.askIdeenChat('ideenBoard.chat.starter.erledigt');
  },

  // Tipp nur, wenn genug offene Ideen an Abschnitten/Kapiteln hängen.
  ideenCheckTipDue() {
    return !this.ideenChatOpen && openAnchoredIdeenCount(this.ideen) >= IDEEN_CHECK_MIN;
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
