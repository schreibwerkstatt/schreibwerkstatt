// Ideen-Vorschläge im Abschnitts- und Buch-Chat (context_info.proposals einer
// Assistant-Nachricht, Typ `idee_create`, Format: lib/chat-idee-proposals.js).
// Gespreadet in chatMethods (chat.js) und bookChatMethods (book-chat.js) —
// `this` ist die jeweilige Chat-Karte; das Fragment chat-idee-vorschlaege.html
// ruft nur die Methoden hier.
//
// Erfassen läuft über DIESELBE Route wie die Ideen-Karte (POST /ideen: Buch-ACL,
// Anker im Buch), danach hält PATCH /ideen/chat-proposal fest, DASS erfasst bzw.
// verworfen wurde — sonst stünde der Vorschlag nach einem Reload wieder offen
// da. Der Text lässt sich vor dem Erfassen bearbeiten (transient `_draft`).
// Transient am Vorschlagsobjekt: _draft, _editing, _busy, _error, _createdId.

import { fetchJson } from '../utils.js';
import { tFetchError } from '../i18n.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function _patchStatus(msg, index, action, appliedId = null) {
  const { proposal } = await fetchJson('/ideen/chat-proposal', {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      message_id: msg.id, index, action,
      ...(appliedId ? { applied_id: appliedId } : {}),
    }),
  });
  return proposal;
}

// Persistierten Stand übernehmen, transiente Felder behalten.
function _merge(p, proposal) {
  if (!proposal) return;
  for (const k of ['applied_at', 'applied_id', 'status']) {
    if (k in proposal) p[k] = proposal[k];
    else delete p[k];
  }
}

// Sidebar-Plakette + Zähler des offenen Abschnitts bzw. Kapitels nachziehen
// (eine neue Idee ist offen). Gleiche Maps wie book/ideen.js#_setTreeIdeenCount.
function _bumpIdeenCount({ page_id: pageId, chapter_id: chapterId }) {
  const isPage = pageId != null;
  const id = isPage ? pageId : chapterId;
  const mapKey = isPage ? 'ideenCounts' : 'chapterIdeenCounts';
  const badges = window.Alpine?.store('badges');
  if (badges) {
    const next = { ...(badges[mapKey] || {}) };
    next[id] = (next[id] || 0) + 1;
    badges[mapKey] = next;
  }
  const app = window.__app;
  if (!app) return;
  if (isPage && app.currentPage?.id === id) app.currentPageIdeenOpenCount = (app.currentPageIdeenOpenCount || 0) + 1;
  if (!isPage && app.ideenChapterId === id) app.currentChapterIdeenOpenCount = (app.currentChapterIdeenOpenCount || 0) + 1;
}

export const chatIdeeProposalMethods = {
  /** Ideen-Vorschläge einer Nachricht als [{ p, idx }] (idx = Index in proposals). */
  chatIdeeProposals(msg) {
    const list = msg?.role === 'assistant' ? msg.context_info?.proposals : null;
    if (!Array.isArray(list)) return [];
    return list.map((p, idx) => ({ p, idx })).filter(e => e.p?.type === 'idee_create');
  },

  chatIdeeState(p) {
    if (p?.applied_at) return 'applied';
    if (p?.status === 'discarded') return 'discarded';
    return 'open';
  },

  editChatIdee(p) {
    if (p._draft == null) p._draft = p.fields?.content || '';
    p._editing = !p._editing;
  },

  async captureChatIdee(msg, idx) {
    const p = msg?.context_info?.proposals?.[idx];
    const app = window.__app;
    if (!p || p._busy || !msg.id) return;
    const content = String(p._draft ?? p.fields?.content ?? '').trim();
    if (!content) { p._error = app.t('chat.ideeEmpty'); return; }
    const bookId = parseInt(window.Alpine.store('nav').selectedBookId, 10);
    p._busy = true;
    p._error = '';
    try {
      // Ist die Idee schon angelegt und nur der Status-PATCH gescheitert, legt
      // ein zweiter Klick keine Dublette an, sondern holt nur den Status nach.
      if (!p._createdId) {
        const row = await fetchJson('/ideen', {
          method: 'POST',
          headers: JSON_HEADERS,
          // Anker: Abschnitt ODER Kapitel — genau eins steht in fields.
          body: JSON.stringify({
            book_id: bookId, content,
            ...(p.fields.page_id != null ? { page_id: p.fields.page_id } : { chapter_id: p.fields.chapter_id }),
          }),
        });
        p._createdId = row?.id || null;
        _bumpIdeenCount(p.fields);
        // Erfasster Text ersetzt den Vorschlag in der Anzeige (lokal; der Server
        // hält nur den Status fest, die Idee selbst steht in `ideen`).
        p.fields = { ...p.fields, content };
        p._editing = false;
      }
      _merge(p, await _patchStatus(msg, idx, 'applied', p._createdId));
    } catch (e) {
      console.error('[captureChatIdee]', e);
      p._error = tFetchError(e);
    } finally {
      p._busy = false;
    }
  },

  async toggleDiscardChatIdee(msg, idx) {
    const p = msg?.context_info?.proposals?.[idx];
    if (!p || p._busy || !msg.id) return;
    p._busy = true;
    p._error = '';
    try {
      _merge(p, await _patchStatus(msg, idx, p.status === 'discarded' ? 'reopen' : 'discarded'));
      p._editing = false;
    } catch (e) {
      console.error('[toggleDiscardChatIdee]', e);
      p._error = tFetchError(e);
    } finally {
      p._busy = false;
    }
  },
};
