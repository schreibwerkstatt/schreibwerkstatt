// Ideen-Vorschläge im Abschnitts-, Buch- und Recherche-Chat (context_info.proposals
// einer Assistant-Nachricht, Typ `idee_create`, Format: lib/chat-idee-proposals.js;
// nur Abschnitts-Chat zusätzlich `idee_update` — Text/Stufe einer offenen Idee,
// «erledigt» mit geprüftem Beleg, normalizeChatIdeeUpdates).
// Gespreadet in chatMethods (chat.js), bookChatMethods (book-chat.js) und
// researchChatMethods (research-chat.js) — `this` ist die jeweilige Chat-Karte;
// das Fragment chat-idee-vorschlaege.html ruft nur die Methoden hier.
//
// Erfassen läuft über DIESELBE Route wie die Ideen-Karte (POST /ideen: Buch-ACL,
// Anker im Buch), danach hält PATCH /ideen/chat-proposal fest, DASS erfasst bzw.
// verworfen wurde — sonst stünde der Vorschlag nach einem Reload wieder offen
// da. Der Text lässt sich vor dem Erfassen bearbeiten (transient `_draft`).
// Transient am Vorschlagsobjekt: _draft, _editing, _busy, _error und
// _written/_appliedId (Idee angelegt, Status noch nicht — proposal-status.js#applyProposalOnce).

import { sendJson, fetchJson } from '../utils.js';
import { tFetchError } from '../i18n.js';
import { persistProposalStatus, applyProposalOnce, proposalApplyError, proposalBaseState } from './proposal-status.js';
import { trackChatProposal } from '../features-usage.js';
import { ideeUpdateRows, confirmIdeeBeleg } from './ideen-chat-proposals.js';
import { IDEE_OPEN_STATUSES } from '../book/ideen-shared.js';
import { EVT } from '../events.js';

// Sidebar-Plakette + Zähler des offenen Abschnitts bzw. Kapitels nachziehen
// (+1: neue Idee ist offen, −1: eine offene ist abgeschlossen). Gleiche Maps wie
// book/ideen.js#_setTreeIdeenCount.
function _bumpIdeenCount({ page_id: pageId, chapter_id: chapterId }, delta = 1) {
  const isPage = pageId != null;
  const id = isPage ? pageId : chapterId;
  if (id == null) return;
  const mapKey = isPage ? 'ideenCounts' : 'chapterIdeenCounts';
  const badges = window.Alpine?.store('badges');
  if (badges) {
    const next = { ...(badges[mapKey] || {}) };
    const n = Math.max(0, (next[id] || 0) + delta);
    if (n > 0) next[id] = n; else delete next[id];
    badges[mapKey] = next;
  }
  const app = window.__app;
  if (!app) return;
  const bump = (v) => Math.max(0, (v || 0) + delta);
  if (isPage && app.currentPage?.id === id) app.currentPageIdeenOpenCount = bump(app.currentPageIdeenOpenCount);
  if (!isPage && app.ideenChapterId === id) app.currentChapterIdeenOpenCount = bump(app.currentChapterIdeenOpenCount);
}

// Ideen-Karte (falls offen) lädt neu — der Vorschlag hat am Server geschrieben.
function _ideenChanged() {
  const bookId = parseInt(window.Alpine?.store('nav')?.selectedBookId, 10) || null;
  window.dispatchEvent(new CustomEvent(EVT.IDEEN_CHANGED, { detail: { bookId } }));
}

// Aktueller Stand der Idee eines idee_update (über die Liste ihres Ankers, gleiche
// Route wie die Ideen-Karte) — null = gibt es nicht mehr. Ohne Anker im Vorschlag:
// undefined (nicht prüfbar, die PATCH-Route entscheidet).
async function _currentIdee(p) {
  const s = p.scope;
  if (!s?.id || (s.kind !== 'page' && s.kind !== 'chapter')) return undefined;
  const list = await fetchJson(`/ideen?${s.kind === 'page' ? 'page_id' : 'chapter_id'}=${encodeURIComponent(s.id)}`);
  return (Array.isArray(list) ? list : []).find(i => i.id === p.idee_id) || null;
}

// Alle Wirte spreaden dieselben Methoden; welcher Chat es ist, sagt die
// Nachrichtenliste, in der die Nachricht steht. Auch per ID: der Recherche-Chat
// ersetzt eine Nachricht nach dem Speichern eines Fundstücks durch ein neues
// Objekt (research-chat-proposals.js#_replaceResearchProposal), ein laufender Ideen-Klick
// hält dann noch das alte. Die IDs sind über alle Chats eindeutig (chat_messages).
function _inList(list, msg) {
  return Array.isArray(list) && list.some(m => m === msg || (msg?.id != null && m?.id === msg.id));
}
function _chatKind(host, msg) {
  if (_inList(host.researchChatMessages, msg)) return 'research';
  return _inList(host.bookChatMessages, msg) ? 'book' : 'page';
}

export const chatIdeeProposalMethods = {
  /** Ideen-Vorschläge einer Nachricht als [{ p, idx }] (idx = Index in proposals). */
  chatIdeeProposals(msg) {
    const list = msg?.role === 'assistant' ? msg.context_info?.proposals : null;
    if (!Array.isArray(list)) return [];
    return list.map((p, idx) => ({ p, idx })).filter(e => e.p?.type === 'idee_create' || e.p?.type === 'idee_update');
  },

  /** Feld-Zeilen eines idee_update (vorher → nachher, Text als Wort-Diff). */
  chatIdeeUpdateRows(p) { return ideeUpdateRows(p); },

  chatIdeeState(p) { return proposalBaseState(p); },

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
    // Ist die Idee schon angelegt und nur der Status-PATCH gescheitert, legt ein
    // zweiter Klick keine Dublette an, sondern holt nur den Status nach.
    const r = await applyProposalOnce('/ideen/chat-proposal', msg, idx, async () => {
      // Anker: Abschnitt ODER Kapitel — genau eins steht in fields.
      const row = await sendJson('/ideen', 'POST', {
        book_id: bookId, content,
        ...(p.fields.page_id != null ? { page_id: p.fields.page_id } : { chapter_id: p.fields.chapter_id }),
      });
      // Der Server legt sie ggf. an einen anderen Anker (Einabschnitts-Kapitel →
      // Abschnitt, lib/idee-anchor.js) — gezählt wird, wo sie wirklich hängt.
      _bumpIdeenCount(row?.page_id != null || row?.chapter_id != null ? row : p.fields);
      _ideenChanged();
      // Erfasster Text ersetzt den Vorschlag in der Anzeige (lokal; der Server
      // hält nur den Status fest, die Idee selbst steht in `ideen`).
      p.fields = { ...p.fields, content };
      p._editing = false;
      return row?.id || null;
    });
    if (!r.ok) {
      // Schreibfehler: Server-Grund; angelegt, nur der Status fehlt: eigener
      // Hinweis (der nächste Klick holt nur den Status nach).
      if (r.phase !== 'cancelled') console.error('[captureChatIdee]', r.error);
      const err = proposalApplyError(r, { applyKey: 'ideenBoard.chat.applyError', statusKey: 'chat.ideeCaptureStatusError' });
      if (err) p._error = err;
    } else if (!r.already) {
      trackChatProposal(_chatKind(this, msg), 'applied', p.type);
    }
    p._busy = false;
  },

  // Änderung an einer bestehenden Idee übernehmen (nur Abschnitts-Chat): erst den
  // Beleg eines «erledigt» gegen den AKTUELLEN Abschnitt prüfen und den Stand der
  // Idee nachlesen (gelöscht → Hinweis, seither geändert → Rückfrage), dann über
  // dieselbe Route wie die Ideen-Karte (PATCH /ideen/:id) schreiben.
  async applyChatIdeeUpdate(msg, idx) {
    const p = msg?.context_info?.proposals?.[idx];
    const app = window.__app;
    if (!p || p.type !== 'idee_update' || p._busy || !msg.id) return;
    p._busy = true;
    p._error = '';
    try {
      if (!p._written) {
        if (!(await confirmIdeeBeleg(msg, idx, p, (s) => app.t('ideen.status.' + s)))) return;
        const cur = await _currentIdee(p);
        if (cur === null) { p._error = app.t('ideenBoard.chat.block.ideeGone'); return; }
        const b = p.before || {};
        const stale = cur && Object.keys(b).some(k => (cur[k] ?? null) !== (b[k] ?? null));
        if (stale && !(await app.appConfirm({ message: app.t('chat.ideeStaleConfirm') }))) return;
      }
      let row = null;
      const r = await applyProposalOnce('/ideen/chat-proposal', msg, idx, async () => {
        const f = p.fields || {};
        const body = {};
        for (const k of ['content', 'status']) if (k in f) body[k] = f[k];
        row = await sendJson(`/ideen/${p.idee_id}`, 'PATCH', body);
        return p.idee_id;
      });
      if (row) {
        // Offene Idee abgeschlossen bzw. wieder geöffnet: Plaketten nachziehen.
        const wasOpen = IDEE_OPEN_STATUSES.includes(p.before?.status ?? 'offen');
        const isOpen = IDEE_OPEN_STATUSES.includes(row.status);
        if (wasOpen !== isOpen) _bumpIdeenCount(row, isOpen ? 1 : -1);
        _ideenChanged();
      }
      if (r.ok) { if (!r.already) trackChatProposal(_chatKind(this, msg), 'applied', p.type); return; }
      const err = proposalApplyError(r, { applyKey: 'ideenBoard.chat.applyError', statusKey: 'chat.ideeUpdateStatusError' });
      if (err) p._error = err;
    } catch (e) {
      console.error('[applyChatIdeeUpdate]', e);
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
      const action = p.status === 'discarded' ? 'reopen' : 'discarded';
      await persistProposalStatus('/ideen/chat-proposal', msg, idx, action);
      trackChatProposal(_chatKind(this, msg), action === 'reopen' ? 'reopened' : 'discarded', p.type);
      p._editing = false;
    } catch (e) {
      console.error('[toggleDiscardChatIdee]', e);
      p._error = tFetchError(e);
    } finally {
      p._busy = false;
    }
  },
};
