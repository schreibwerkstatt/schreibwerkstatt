import { makeChatMethods } from './chat-base.js';
import { fetchJson } from '../utils.js';
import { pageChatMarksMethods } from './page-chat-marks.js';
import { pageChatApplyMethods } from './page-chat-apply.js';

// Seiten-Chat-Methoden (werden in Alpine.data('chatCard') gespreadet).
// Gemeinsame Logik kommt aus chat-base.js; hier nur Seiten-Chat-Spezifika:
// Vorschlags-Zustand + Inline-Marken (page-chat-marks.js) und Übernehmen /
// Rückgängig / Verwerfen / Titelvarianten (page-chat-apply.js).

// Der KI-Titel einer neuen Session entsteht serverseitig NACH dem Job-Ende
// (routes/jobs/chat/page-chat.js) — die Historie holt ihn einmal verzögert nach.
const TITLE_REFRESH_MS = 6000;
// Vor dem Senden auf einen laufenden Autosave warten: höchstens 20 × 150 ms.
const FLUSH_WAIT_STEPS = 20;
const FLUSH_WAIT_MS = 150;

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
  // Vor dem Senden: Editor-Stand auf den Server bringen, damit der Job den Text
  // sieht, den der User vor Augen hat (Autosave läuft nur alle 30s), und den
  // View-State auf den Server-Stand ziehen, gegen den die Vorschläge entstehen.
  //  - Edit-Modus: Notebook-Pfad `_pullRemoteIntoEditor` (edit/conflict.js) —
  //    DOM, `originalHtml` und `updated_at` immer gemeinsam (still übernehmen,
  //    Block-Merge oder Konflikt-Banner). Nur `originalHtml` umzusetzen hiesse:
  //    falsche Merge-Basis, der nächste Save dreht die Remote-Änderung still zurück.
  //  - Leseansicht: `_refetchCurrentPage` (originalHtml + updated_at + Render-State).
  // Scheitert das Flush (offline, Konflikt), sieht der Chat den zuletzt
  // gespeicherten Stand — das steht als Hinweis über dem Eingabefeld.
  onBeforeSend: async function () {
    const root = window.__app;
    this.chatFlushFailed = false;
    if (root.editMode) {
      // Laufender Autosave: abwarten statt daneben zu speichern.
      for (let i = 0; i < FLUSH_WAIT_STEPS && root.editSaving; i++) {
        await new Promise(r => setTimeout(r, FLUSH_WAIT_MS));
      }
      if (root.editDirty && !root.editSaving) {
        try { await root.quickSave(); }
        catch (e) { console.warn('[sendChatMessage] quickSave fehlgeschlagen:', e.message); }
      }
      if (root.editDirty || root.editSaving) this.chatFlushFailed = true;
      try { await root._pullRemoteIntoEditor?.(); }
      catch (e) { console.warn('[sendChatMessage] Server-Stand nicht übernommen:', e.message); }
    } else if (root.currentPage) {
      await root._refetchCurrentPage?.();
    }
    this._chatPendingRefresh = false;
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
  // Laufende Antwort abbrechen (gleiche Mechanik wie der Buch-Chat): der Job
  // ist über die Session-ID registriert (`_handleChatPost`, entityId), der
  // Abbruch läuft über DELETE /jobs/:id (Root `cancelJob`). Der Poller sieht
  // danach den Status 'cancelled' und räumt den Lauf ab.
  async cancelChatRun() {
    const sid = this.chatRunningSessionId;
    if (!sid) return;
    try {
      const active = await fetchJson(`/jobs/active?type=chat&book_id=${sid}`);
      if (active?.jobId) await window.__app.cancelJob(active.jobId);
    } catch (e) {
      console.error('[cancelChatRun]', e);
    }
  },
  ...pageChatMarksMethods,
  ...pageChatApplyMethods,
};
