// Alpine.data('chatHistorySearch') — Suche im eigenen Verlauf, verschachtelt in
// die Verlaufs-Sektion von Abschnitts-Chat (`chatHistorySearch('page')`) und
// Buch-Chat (`chatHistorySearch('book')`), Markup: partials/chat-history-search.html.
// Server: GET /chat/search/:book_id (Wortlaut + Bedeutung, docs/chats.md#suche-im-verlauf).
//
// Ein Klick lädt das Gespräch über die Lade-Methode der umgebenden Karte
// (`loadChatSession` / `loadBookChatSession`, Scope-Merge) und springt zur
// gefundenen Nachricht (chat-base.js, `jumpToMsgId`). Liegt ein Abschnitts-Treffer
// auf einem anderen Abschnitt, wird erst dorthin navigiert: der Seitenwechsel
// schliesst den Abschnitts-Chat, das Gespräch wird darum vor dem Wieder-Öffnen
// geladen — das Öffnen lädt dann nicht mehr das neueste Gespräch.
// State-Namen mit `hist`-Präfix: sie teilen sich den Scope mit der Karte.

import { fetchJson } from '../utils.js';
import { tFetchError } from '../i18n.js';

const MIN_CHARS = 2;
const DEBOUNCE_MS = 350;

export function registerChatHistorySearch() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('chatHistorySearch', (kind) => ({
    histKind: kind === 'book' ? 'book' : 'page',
    histQuery: '',
    // Abschnitts-Chat: nur dieser Abschnitt ('page') oder alle Abschnitte ('book').
    histScope: 'page',
    histHits: [],
    histLoading: false,
    histSearched: false,
    histNote: '',
    histError: '',
    _histGen: 0,
    _histTimer: null,

    destroy() { clearTimeout(this._histTimer); },

    get histActive() { return this.histQuery.trim().length >= MIN_CHARS; },

    onHistInput() {
      clearTimeout(this._histTimer);
      if (!this.histActive) { this.clearHistSearch(false); return; }
      this._histTimer = setTimeout(() => this.runHistSearch(), DEBOUNCE_MS);
    },

    setHistScope(scope) {
      if (this.histScope === scope) return;
      this.histScope = scope;
      if (this.histActive) this.runHistSearch();
    },

    clearHistSearch(resetQuery = true) {
      clearTimeout(this._histTimer);
      this._histGen++;
      if (resetQuery) this.histQuery = '';
      this.histHits = [];
      this.histSearched = false;
      this.histLoading = false;
      this.histNote = '';
      this.histError = '';
    },

    async runHistSearch() {
      const root = window.__app;
      const bookId = window.Alpine.store('nav').selectedBookId;
      const q = this.histQuery.trim();
      if (!bookId || q.length < MIN_CHARS) return;
      const params = new URLSearchParams({ q, kind: this.histKind });
      if (this.histKind === 'page' && this.histScope === 'page') {
        if (!root.currentPage) return;
        params.set('page_id', root.currentPage.id);
      }
      const g = ++this._histGen;
      this.histLoading = true;
      this.histError = '';
      try {
        const data = await fetchJson(`/chat/search/${bookId}?${params}`);
        if (g !== this._histGen) return;
        this.histHits = data.hits || [];
        this.histNote = data.semanticError
          ? root.t('chat.historySearch.semanticUnavailable')
          : (data.indexing ? root.t('chat.historySearch.indexing', { n: data.pending }) : '');
      } catch (e) {
        if (g !== this._histGen) return;
        this.histHits = [];
        this.histError = root.t('common.errorColon') + tFetchError(e);
      } finally {
        if (g === this._histGen) { this.histLoading = false; this.histSearched = true; }
      }
    },

    histHitTip(hit) {
      return window.__app.t(`chat.historySearch.match.${hit.match}`);
    },

    async openHistHit(hit) {
      const opts = { jumpToMsgId: hit.message_id };
      if (this.histKind === 'book') return this.loadBookChatSession(hit.session_id, opts);
      const root = window.__app;
      if (String(root.currentPage?.id) === String(hit.page_id)) return this.loadChatSession(hit.session_id, opts);
      await root.gotoPageById(hit.page_id);
      if (String(root.currentPage?.id) !== String(hit.page_id)) return; // Wechsel abgelehnt
      await this.loadChatSession(hit.session_id, opts);
      if (!root.showChatCard) await root.toggleChatCard();
    },
  }));
}
