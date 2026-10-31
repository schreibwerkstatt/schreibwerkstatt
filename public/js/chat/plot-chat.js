import { makeChatMethods } from './chat-base.js';
import { plotProposalMethods } from './plot-chat-proposals.js';

// Plot-Chat-Methoden (gespreadet in die plotCard). Agentischer Chat NEBEN dem
// Beat-Board: liest Board, Figuren, Szenen und Text und schlägt Änderungen am
// Board vor, die der User einzeln übernimmt (plot-chat-proposals.js).
// Jeder Provider (agentisch oder klassisch, serverseitig). Deep-Doc: docs/plot-chat.md

/** Zusatz-State der Karte (Sessions/Verlauf/Lauf). */
export function plotChatState() {
  return {
    plotChatOpen: false,
    plotChatSessions: [],
    plotChatMessages: [],
    plotChatSessionId: null,
    plotChatInput: '',
    plotChatLoading: false,
    plotChatRunningSessionId: null,
    plotChatProgress: 0,
    plotChatStatus: '',
    _plotChatPollTimer: null,
    _plotChatGen: 0,
  };
}

export const plotChatMethods = {
  async togglePlotChat() {
    this.plotChatOpen = !this.plotChatOpen;
    if (this.plotChatOpen) {
      await this._onVisiblePlotChat();
      this.$nextTick(() => this.$root?.querySelector('.plot-chat-input')?.focus());
    }
  },

  ...plotProposalMethods,

  ...makeChatMethods({
    label: 'PlotChat',
    props: {
      sessions: 'plotChatSessions',
      messages: 'plotChatMessages',
      sessionId: 'plotChatSessionId',
      input: 'plotChatInput',
      loading: 'plotChatLoading',
      runningSessionId: 'plotChatRunningSessionId',
      status: 'plotChatStatus',
      progress: 'plotChatProgress',
      pollTimer: '_plotChatPollTimer',
      gen: '_plotChatGen',
    },
    scrollElId: 'plot-chat-messages',
    activeJobType: 'plot-chat',
    canOpen: () => !!Alpine.store('nav').selectedBookId,
    sessionsUrl: () => '/chat/sessions/plot/' + Alpine.store('nav').selectedBookId,
    newSessionUrl: '/chat/session/plot',
    newSessionBody: () => ({ book_id: parseInt(Alpine.store('nav').selectedBookId) }),
    sendUrl: '/jobs/plot-chat',
  }),
};
