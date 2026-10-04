'use strict';
// Thread-Karten des Readers (verankerte Leiste, allgemeine Sektion, Mobile-
// Sheet). Optik aus der geteilten Karte (.comment-rail__*,
// components/comment-rail.css); `share-thread` bleibt Hook für die
// Margin-Note-Positionierung (layout.js) + setActive.
//
// Die Antwort-Box steht nicht dauerhaft an jeder Karte (Google-Docs-Muster): ein
// „Antworten"-Knopf klappt sie auf. Offene Boxen + Entwürfe überleben das
// Re-Render (Live-Poll, eigene Aktion), weil sie hier statt im DOM leben.

import { resolveCurrentQuote } from '../share-anchor.js';
import { avatarHue, avatarInitials } from '../avatar.js';
import { el, timeEl, submitOnModEnter } from './dom.js';

// deps:
//   t, article, api, savedName
//   reload()                 → Threads neu laden + rendern
//   setActive(id)            → Thread auswählen (Highlight + Pin)
//   scrollToAnchor(id)       → zur Textstelle springen
//   isAnchorLocated(c)       → hat der Root eine lokalisierte Textstelle?
//   unseenReplies(node), markThreadSeen(node)
//   onResize()               → Kartenhöhe geändert (Layout neu rechnen)
export function createThreadRenderer(deps) {
  const { t, article, api, savedName, reload, setActive, scrollToAnchor,
    isAnchorLocated, unseenReplies, markThreadSeen, onResize } = deps;
  const openReplies = new Set();
  const drafts = new Map();

  function authorName(c) {
    if (c.is_author) return t('author_badge');
    if (c.mine) return c.name ? `${c.name} (${t('you_badge')})` : t('you_badge');
    return c.name || t('anon');
  }

  // Avatar-Daten aus den geteilten pure Primitiven (public/js/avatar.js, SSoT mit
  // der SPA-Leiste). Leser haben keine Email → Seed/Initialen aus dem Anzeigenamen;
  // der Autor bekommt einen festen Seed (gleich im SSR, lib/share-comments-ssr.js).
  function renderMeta(c) {
    const meta = el('div', 'comment-rail__meta');
    const label = authorName(c);
    const avatar = el('span', 'comment-rail__avatar', avatarInitials(label));
    avatar.setAttribute('aria-hidden', 'true');
    avatar.style.setProperty('--avatar-hue', avatarHue(c.is_author ? 'author' : (c.name || 'anon')));
    meta.appendChild(avatar);
    meta.appendChild(el('span', 'comment-rail__author', label));
    meta.appendChild(timeEl(c.created_at, 'comment-rail__time'));
    if (c.edited_at) meta.appendChild(el('span', 'comment-rail__edited', t('edited_badge')));
    if (c.resolved) meta.appendChild(el('span', 'comment-rail__resolved', t('resolved_badge')));
    return meta;
  }

  function statusEl() {
    const s = el('span', 'share-comments__status');
    s.setAttribute('role', 'status');
    return s;
  }

  function ghostButton(label) {
    const b = el('button', 'share-composer__cancel', label);
    b.type = 'button';
    return b;
  }

  // Fuss der Karte: zugeklappt ein „Antworten"-Knopf, aufgeklappt die Box.
  function fillFoot(foot, root) {
    foot.innerHTML = '';
    if (!openReplies.has(root.id)) {
      const toggle = el('button', 'share-thread__action share-thread__reply-toggle', t('reply'));
      toggle.type = 'button';
      toggle.addEventListener('click', () => {
        openReplies.add(root.id);
        if (isAnchorLocated(root)) setActive(root.id);
        fillFoot(foot, root);
        const ta = foot.querySelector('textarea');
        if (ta) ta.focus();
        onResize();
      });
      foot.appendChild(toggle);
      return;
    }
    foot.appendChild(renderReplyForm(foot, root));
  }

  function renderReplyForm(foot, root) {
    const form = el('form', 'comment-rail__reply');
    const ta = el('textarea', 'comment-rail__textarea');
    ta.rows = 2;
    ta.required = true;
    ta.maxLength = 4000;
    ta.placeholder = t('reply_placeholder');
    ta.setAttribute('aria-label', t('reply_placeholder'));
    ta.value = drafts.get(root.id) || '';
    ta.addEventListener('input', () => drafts.set(root.id, ta.value));
    const actions = el('div', 'share-thread__reply-actions');
    const btn = el('button', null, t('send'));
    btn.type = 'submit';
    const cancel = ghostButton(t('cancel'));
    const status = statusEl();
    actions.appendChild(btn);
    actions.appendChild(cancel);
    actions.appendChild(status);
    form.appendChild(ta);
    form.appendChild(actions);
    cancel.addEventListener('click', () => {
      openReplies.delete(root.id);
      drafts.delete(root.id);
      fillFoot(foot, root);
      onResize();
    });
    submitOnModEnter(ta, () => form.requestSubmit());
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const body = (ta.value || '').trim();
      if (!body) { status.textContent = t('form_empty'); return; }
      btn.disabled = true;
      try {
        await api.postComment({ parent_id: root.id, body, reader_name: savedName() });
        openReplies.delete(root.id);
        drafts.delete(root.id);
        ta.value = '';
        await reload();
      } catch (e) {
        status.textContent = e.status === 429 ? t('comment_rate_limited') : t('form_error');
        btn.disabled = false;
      }
    });
    return form;
  }

  // Body-Element durch einen Inline-Editor ersetzen. Bei Speichern lädt reload()
  // die Liste neu (rebaut die Karte); bei Abbruch wird der Body wiederhergestellt.
  function startEditInline(c, bodyEl, status) {
    const editor = el('div', 'share-thread__edit');
    const ta = el('textarea', 'comment-rail__textarea');
    ta.rows = 3;
    ta.maxLength = 4000;
    ta.value = c.body || '';
    ta.setAttribute('aria-label', t('edit'));
    const acts = el('div', 'share-thread__reply-actions');
    const save = el('button', null, t('edit_save'));
    save.type = 'button';
    const cancel = ghostButton(t('cancel'));
    acts.appendChild(save);
    acts.appendChild(cancel);
    editor.appendChild(ta);
    editor.appendChild(acts);
    bodyEl.replaceWith(editor);
    setTimeout(() => ta.focus(), 20);
    onResize();
    cancel.addEventListener('click', () => { editor.replaceWith(bodyEl); onResize(); });
    const doSave = async () => {
      const val = (ta.value || '').trim();
      if (!val) { status.textContent = t('form_empty'); return; }
      save.disabled = true;
      try { await api.editOwnComment(c.id, val); await reload(); }
      catch { status.textContent = t('form_error'); save.disabled = false; }
    };
    save.addEventListener('click', doSave);
    submitOnModEnter(ta, doSave);
  }

  // Self-Service-Aktionen für eigene Kommentare (mine). Root: Erledigt-Toggle +
  // Bearbeiten + Löschen (nur ohne Antworten); Antwort-Beiträge: Bearbeiten +
  // Löschen. Auf Hover-Geräten erst bei Hover/Auswahl/Fokus sichtbar (CSS).
  function renderOwnActions(c, { isRoot, hasReplies, bodyEl }) {
    const actions = el('div', 'share-thread__actions');
    const status = statusEl();

    if (isRoot) {
      const toggle = el('button', 'share-thread__action', c.resolved ? t('reopen') : t('mark_done'));
      toggle.type = 'button';
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try { await api.resolveOwnComment(c.id, !c.resolved); await reload(); }
        catch { status.textContent = t('form_error'); toggle.disabled = false; }
      });
      actions.appendChild(toggle);
    }

    const edit = el('button', 'share-thread__action', t('edit'));
    edit.type = 'button';
    edit.addEventListener('click', () => startEditInline(c, bodyEl, status));
    actions.appendChild(edit);

    // Antworten sind Blätter → immer löschbar. Root nur ohne Antworten (sonst
    // risse CASCADE die Autor-Antwort mit — serverseitig geblockt).
    if (!isRoot || !hasReplies) {
      const del = el('button', 'share-thread__action share-thread__action--danger', t('delete'));
      del.type = 'button';
      del.addEventListener('click', async () => {
        if (!window.confirm(t('delete_confirm'))) return;
        del.disabled = true;
        try { await api.deleteOwnComment(c.id); await reload(); }
        catch (e) {
          status.textContent = e.message === 'HAS_REPLIES' ? t('delete_has_replies') : t('form_error');
          del.disabled = false;
        }
      });
      actions.appendChild(del);
    }

    actions.appendChild(status);
    return actions;
  }

  // Anker-Zeile: getönter Quote-Snippet + Sprung bzw. Stale-Hinweis.
  // resolveCurrentQuote trennt „Block weg" (gone) von „Text geändert" (changed).
  // Bewusst KEIN Wort-Diff im öffentlichen Reader — der Drift-Diff bleibt
  // owner-only (Notebook-/Bucheditor-Leiste).
  function renderAnchorRow(root) {
    const row = el('div', 'comment-rail__anchor');
    const res = resolveCurrentQuote(article, root.anchor);
    const gone = !isAnchorLocated(root) || res.status === 'gone';
    const changed = !gone && res.status === 'changed';
    row.appendChild(el('span', 'comment-rail__quote' + (gone || changed ? ' comment-rail__quote--stale' : ''), root.anchor.quote || ''));
    if (gone || changed) row.appendChild(el('span', 'share-thread__stale', t(gone ? 'anchor_stale' : 'anchor_changed')));
    if (!gone) {
      row.setAttribute('role', 'button');
      row.tabIndex = 0;
      row.title = t('jump_to_text');
      const jump = (e) => { e.stopPropagation(); scrollToAnchor(root.id); };
      row.addEventListener('click', jump);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); jump(e); } });
    }
    return row;
  }

  function renderThread(node, { activeId } = {}) {
    const { root, replies } = node;
    const li = el('li', 'comment-rail__thread share-thread');
    li.dataset.commentId = root.id;
    if (root.resolved) li.classList.add('comment-rail__thread--resolved');
    if (root.id === activeId) li.classList.add('comment-rail__thread--selected');

    // Klick auf die Karte wählt sie aus (Highlight der Textstelle + Pin) — nur
    // bei verankerten Threads mit auffindbarer Stelle; Bedienelemente nicht.
    const selectable = !!root.anchor && isAnchorLocated(root);
    if (selectable) {
      li.classList.add('share-thread--selectable');
      li.addEventListener('click', (e) => {
        if (e.target.closest('button, textarea, input, a, form, [role="button"]')) return;
        setActive(root.id);
      });
    }

    // Ungelesen-Badge: fremde Antworten, die dieser Browser noch nicht gesehen
    // hat. Erste Interaktion mit der Karte markiert sie als gesehen.
    const unseen = unseenReplies(node);
    if (unseen.length) {
      const label = unseen.length > 1 ? `${t('new_reply_badge')} (${unseen.length})` : t('new_reply_badge');
      const badge = el('span', 'share-thread__unread', label);
      li.appendChild(badge);
      li.addEventListener('click', () => { if (markThreadSeen(node)) badge.remove(); }, { once: true });
    }

    if (root.anchor) li.appendChild(renderAnchorRow(root));

    const rootComment = el('div', 'comment-rail__comment');
    rootComment.appendChild(renderMeta(root));
    const rootBody = el('div', 'comment-rail__body', root.body);
    rootComment.appendChild(rootBody);
    if (root.mine) rootComment.appendChild(renderOwnActions(root, { isRoot: true, hasReplies: replies.length > 0, bodyEl: rootBody }));
    li.appendChild(rootComment);

    // Antworten (abgesetzt; Autor-Antworten mit Akzentbalken).
    for (const r of replies) {
      const rEl = el('div', 'comment-rail__comment comment-rail__comment--reply');
      if (r.is_author) rEl.classList.add('comment-rail__comment--author');
      rEl.appendChild(renderMeta(r));
      const rBody = el('div', 'comment-rail__body', r.body);
      rEl.appendChild(rBody);
      if (r.mine) rEl.appendChild(renderOwnActions(r, { isRoot: false, hasReplies: false, bodyEl: rBody }));
      li.appendChild(rEl);
    }

    // Antworten nur in offenen Threads.
    if (!root.resolved) {
      const foot = el('div', 'comment-rail__foot');
      fillFoot(foot, root);
      li.appendChild(foot);
    } else {
      openReplies.delete(root.id);
    }
    return li;
  }

  return { renderThread };
}
