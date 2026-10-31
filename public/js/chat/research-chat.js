import { makeChatMethods } from './chat-base.js';
import { escHtml, renderChatMarkdown } from '../utils.js';
import {
  renderResearchAnswer as _renderResearchAnswerText,
  displaySources as _displaySources,
} from './research-chat-render.js';
import { researchProposalMethods } from './research-chat-proposals.js';
import { takePendingResearchAsk } from './research-chat-ask.js';

// Für rechercheCard: Zusatz-State der Vorschläge + die Frage-Brücke (Buch-Chat →
// Recherche-Chat), damit die Karte nur dieses Modul importiert.
export { researchProposalState } from './research-chat-proposals.js';
export { installResearchChatAskBridge, RESEARCH_CHAT_ASK_PENDING } from './research-chat-ask.js';

// Recherche-Chat-Methoden (gespreadet in die rechercheCard). Agentischer Chat
// NEBEN dem Wissensboard: recherchiert im Netz + im vorhandenen Material und
// schlägt Fundstücke als neue Recherche-Items vor (User bestätigt). Jeder Provider
// mit Tool-Calling: Claude sucht über Anthropic oder SearXNG, die übrigen über
// SearXNG (Gate: lib/research-chat-gate.js, Suchweg: lib/websearch#webSearchMode).

export const researchChatMethods = {
  // Panel auf-/zuklappen. Beim ersten Öffnen Sessions laden (onVisible-Pfad).
  async toggleResearchChat() {
    this.researchChatOpen = !this.researchChatOpen;
    if (this.researchChatOpen) {
      await this._onVisibleResearchChat();
      this.$nextTick(() => {
        const ta = this.$root?.querySelector('.research-chat-input');
        if (ta) ta.focus();
      });
    }
  },

  // Vorbelegte Frage aus einer anderen Oberfläche (Event `research-chat:ask`,
  // research-chat-ask.js) übernehmen: Panel auf, Eingabe vorbelegen, NICHT senden.
  async _consumeResearchChatAsk() {
    const ask = takePendingResearchAsk();
    if (!ask) return;
    if (!this.researchChatOpen) await this.toggleResearchChat();
    this.researchChatInput = ask.question;
    this.$nextTick(() => {
      const ta = this.$root?.querySelector('.research-chat-input');
      if (ta) { ta.focus(); ta.setSelectionRange?.(ta.value.length, ta.value.length); }
    });
  },

  // Web-Such-Trefferdokumente (1-basiert, Auftrittsreihenfolge) aus dem Backend.
  researchSources(msg) {
    return (msg?.context_info?.sources) || [];
  },

  // Assistant-Antwort rendern. Delegiert an die pure Funktion (Unit-testbar);
  // die Alpine-Methode bleibt Bindung-Ziel der Templates (Live-Export erhalten).
  _renderResearchAnswer(msg) {
    this._chatMarkdownDep();
    const app = window.__app;
    return _renderResearchAnswerText({
      text: msg?.content || '',
      sources: this.researchSources(msg),
      answerSources: msg?.context_info?.answer_sources || [],
      proposalCount: this.researchProposals(msg).length,
      renderChatMarkdown,
      escHtml,
      t: (k) => app?.t?.(k) ?? k,
    });
  },

  // Quellenliste unter der Antwort: geprüfte Belege aus final_answer.quellen,
  // sonst die aus den cite-Markern abgeleiteten Treffer (pure Helper, Test teilt ihn).
  researchCitedSources(msg) {
    return _displaySources(msg?.content || '', this.researchSources(msg), msg?.context_info?.answer_sources);
  },

  // Gelaufene Suchbegriffe (server_tool_use.input.query), sichtbar am Fuss.
  // Nur für ältere Antworten: seit die Suchen als Zeilen im Werkzeug-Verlauf stehen
  // (web_search, auch Anthropics serverseitige), wäre der Block eine Doppelung.
  researchWebQueries(msg) {
    const calls = msg?.context_info?.tool_calls;
    if (Array.isArray(calls) && calls.some(tc => tc?.name === 'web_search')) return [];
    return (msg?.context_info?.web_queries || []).filter(q => typeof q === 'string' && q.trim());
  },

  ...researchProposalMethods,

  ...makeChatMethods({
    label: 'ResearchChat',
    props: {
      sessions: 'researchChatSessions',
      messages: 'researchChatMessages',
      sessionId: 'researchChatSessionId',
      input: 'researchChatInput',
      loading: 'researchChatLoading',
      runningSessionId: 'researchChatRunningSessionId',
      status: 'researchChatStatus',
      progress: 'researchChatProgress',
      pollTimer: '_researchChatPollTimer',
      gen: '_researchChatGen',
    },
    scrollElId: 'research-chat-messages',
    activeJobType: 'research-chat',
    canOpen: (ctx) => !!Alpine.store('nav').selectedBookId && !!ctx.$store.config.researchChatEnabled,
    sessionsUrl: (ctx) => '/chat/sessions/research/' + Alpine.store('nav').selectedBookId,
    newSessionUrl: '/chat/session/research',
    newSessionBody: (ctx) => ({
      book_id:   parseInt(Alpine.store('nav').selectedBookId),
      book_name: ctx.$app.selectedBookName,
    }),
    sendUrl: '/jobs/research-chat',
    // Kontext-Chip an → Seite/Kapitel geht mit der Frage an den Server; das
    // Modell bekommt Name, Textauszug und dort verknüpftes Material.
    sendExtra: (ctx) => {
      const t = ctx.researchChatUseContext ? ctx.researchChatContextTarget() : null;
      return t ? { context: { kind: t.kind, id: t.id } } : {};
    },
  }),
};
