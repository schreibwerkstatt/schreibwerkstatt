import { makeChatMethods } from './chat-base.js';
import { contentRepo } from '../repo/content.js';
import { pageChatMarksMethods } from './page-chat-marks.js';
import { pageChatApplyMethods } from './page-chat-apply.js';

// Seiten-Chat-Methoden (werden in Alpine.data('chatCard') gespreadet).
// Gemeinsame Logik kommt aus chat-base.js; hier nur Seiten-Chat-Spezifika:
// Vorschlags-Zustand + Inline-Marken (page-chat-marks.js) und Übernehmen /
// Rückgängig / Verwerfen / Titelvarianten (page-chat-apply.js).

// Der KI-Titel einer neuen Session entsteht serverseitig NACH dem Job-Ende
// (routes/jobs/chat/page-chat.js) — die Historie holt ihn einmal verzögert nach.
const TITLE_REFRESH_MS = 6000;

const baseMethods = makeChatMethods({
  label: 'Chat',
  props: {
    sessions: 'chatSessions',
    messages: 'chatMessages',
    sessionId: 'chatSessionId',
    input: 'chatInput',
    loading: 'chatLoading',
    runningSessionId: 'chatRunningSessionId',
    status: 'chatStatus',
    progress: 'chatProgress',
    pollTimer: '_chatPollTimer',
    gen: '_chatGen',
    pendingRefresh: '_chatPendingRefresh',
  },
  scrollElId: 'chat-messages',
  activeJobType: 'chat',
  canOpen: (ctx) => !!ctx.$app.currentPage,
  sessionsUrl: (ctx) => '/chat/sessions/' + ctx.$app.currentPage.id,
  newSessionUrl: '/chat/session',
  newSessionBody: (ctx) => ({
    book_id:   parseInt(Alpine.store('nav').selectedBookId),
    book_name: ctx.$app.selectedBookName,
    page_id:   ctx.$app.currentPage.id,
    page_name: ctx.$app.currentPage.name,
  }),
  sendUrl: '/jobs/chat',
  onBeforeSend: async function () {
    const root = window.__app;
    // Ungespeicherte Editor-Änderungen flushen, sonst sieht der Chat-Job den
    // alten gespeicherten Stand (Autosave läuft nur alle 30s).
    if (root.editMode && root.editDirty && !root.editSaving) {
      try { await root.quickSave(); }
      catch (e) { console.warn('[sendChatMessage] quickSave fehlgeschlagen:', e.message); }
    }
    try {
      // `fresh: true`: nach quickSave oben muss der Read den neuen Stand sehen
      // (SW-CONTENT_CACHE ist sonst noch stale, falls Cache-Bust noch nicht durch ist).
      const pageData = await contentRepo.loadPage(root.currentPage.id, { fresh: true });
      root.originalHtml = pageData.html || '';
      this._chatPendingRefresh = false;
    } catch (e) {
      console.warn('[sendChatMessage] Seiteninhalt konnte nicht geladen werden:', e.message);
    }
  },
  // Historie frischt die Basis auf; hier bleiben Vorschlags-Zustand + Marken
  // (loadSession → onAfterSessionLoad hat sie für die sichtbare Session schon
  // gesetzt) und der verzögerte Titel-Nachzug.
  onPollDone: function () {
    this._refreshVorschlagStates();
    const row = (this.chatSessions || []).find(s => s.id === this.chatSessionId);
    if (row && !row.title && !this._chatTitleTimer) {
      const gen = this._chatGen;
      this._chatTitleTimer = setTimeout(() => {
        this._chatTitleTimer = null;
        if (this._chatGen === gen) this.loadChatSessions();
      }, TITLE_REFRESH_MS);
    }
  },
  onSessionsChanged: function () {
    const root = window.__app;
    const pageId = root?.currentPage?.id;
    if (!pageId) return;
    root.currentPageChatSessionCount = (this.chatSessions || []).length;
  },
  onAfterSessionLoad: function () {
    this._refreshVorschlagStates();
  },
  onReset: function () {
    if (this._chatTitleTimer) { clearTimeout(this._chatTitleTimer); this._chatTitleTimer = null; }
    this._clearChatMarks();
    window.__app.updatePageView();
  },
});

export const chatMethods = {
  ...baseMethods,
  ...pageChatMarksMethods,
  ...pageChatApplyMethods,
};
