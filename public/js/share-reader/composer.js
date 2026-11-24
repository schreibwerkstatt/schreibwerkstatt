'use strict';
// Schwebender „Kommentieren"-Button an der Textselektion + Composer-Overlay
// (verankerte UND allgemeine Anmerkungen). Standalone-Widget im share-reader/-
// Muster (dom/identity/menu/theme/toc/diff/layout).
//
// Verankerung: charOffset (share-anchor.js, SSoT mit der Owner-Karte) bestimmt
// Start/Ende des markierten Quotes innerhalb des data-bid-Blocks.

import { charOffset } from '../share-anchor.js';
import { el, makeModal, submitOnModEnter } from './dom.js';
import { errorText } from './api.js';

// deps:
//   t            → i18n-Lookup
//   article      → das Artikel-Element (#share-article)
//   postComment  → (payload) => Promise (POST /comment)
//   onPosted     → () => Promise (Threads neu laden)
//   savedName    → () => string|undefined (globaler Identitäts-Name)
//   ensureIdentity → () => Promise<boolean> (fragt vor dem ersten Beitrag nach
//                  dem Namen; false = Leser hat abgebrochen)
//   review       → true: Review-Link — an einer markierten Stelle kann der
//                  Leser statt eines Kommentars eine Aenderung vorschlagen
//                  (Ersatztext + optionale Begruendung, docs/share-link.md)
export function setupComposer({ t, article, postComment, onPosted, savedName, ensureIdentity, review = false }) {
  // {bid, start, end, quote} aus der aktuellen Selektion oder null.
  function anchorFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    const elt = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const block = elt && elt.closest ? elt.closest('[data-bid]') : null;
    if (!block || !article.contains(block)) return null;
    const start = charOffset(block, range.startContainer, range.startOffset);
    const blockLen = block.textContent.length;
    // Reicht die Markierung über den Block hinaus, wird nur der Teil im ersten
    // Block verankert — der Composer sagt das dem Leser (truncated).
    const truncated = !block.contains(range.endContainer);
    let end = !truncated
      ? charOffset(block, range.endContainer, range.endOffset)
      : blockLen;
    if (end > blockLen) end = blockLen;
    if (end <= start) return null;
    const quote = block.textContent.slice(start, end);
    if (!quote.trim()) return null;
    return { bid: block.getAttribute('data-bid'), start, end, quote, truncated };
  }

  const selBtn = el('button', 'share-sel-btn', t('anchor_cta'));
  selBtn.type = 'button';
  selBtn.hidden = true;
  document.body.appendChild(selBtn);
  let pendingAnchor = null;

  function positionSelButton() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { selBtn.hidden = true; return; }
    const a = anchorFromSelection();
    if (!a) { selBtn.hidden = true; return; }
    pendingAnchor = a;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    selBtn.style.top = (window.scrollY + rect.top - 42) + 'px';
    selBtn.style.left = (window.scrollX + rect.left + rect.width / 2) + 'px';
    selBtn.hidden = false;
  }
  document.addEventListener('selectionchange', () => {
    // Nur reagieren, wenn die Selektion im Artikel liegt.
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { selBtn.hidden = true; return; }
    const node = sel.anchorNode;
    if (!node || !article.contains(node.nodeType === 1 ? node : node.parentNode)) { selBtn.hidden = true; return; }
    positionSelButton();
  });
  selBtn.addEventListener('mousedown', (e) => e.preventDefault()); // Selektion nicht verlieren
  selBtn.addEventListener('click', () => {
    if (pendingAnchor) openComposer(pendingAnchor);
    selBtn.hidden = true;
  });

  let release = null;
  // Entwurf: Esc, Abbrechen oder Klick daneben verwerfen den getippten Text
  // nicht — derselbe Anker (bzw. die allgemeine Anmerkung) bekommt ihn beim
  // nächsten Öffnen zurück. Erfolgreiches Senden löscht ihn.
  let draft = null;     // { key, text }
  let current = null;   // { key, ta } des offenen Composers
  const draftKey = (anchor) => (anchor ? `${anchor.bid}:${anchor.start}:${anchor.end}` : 'general');
  function openComposer(anchor) {
    closeComposer();
    const key = draftKey(anchor);
    const overlay = el('div', 'share-composer');
    overlay.id = 'share-composer';
    const card = el('div', 'share-composer__card');
    const title = el('h3', 'share-composer__title', anchor ? t('composer_title') : t('composer_general_title'));
    card.appendChild(title);
    if (anchor) {
      // Ohne literale Anführungszeichen — der Akzentbalken markiert das Zitat
      // (gleiche Optik wie das Quote-Snippet der Karte, sprachneutral).
      card.appendChild(el('blockquote', 'share-composer__quote', anchor.quote));
      if (anchor.truncated) card.appendChild(el('p', 'share-composer__hint', t('anchor_truncated')));
    }
    // Review-Link: Umschalter Kommentar | Aenderung vorschlagen (nur verankert).
    let suggest = false;
    let sugg = null;
    let setMode = null;
    if (review && anchor) {
      const seg = el('div', 'share-composer__modes');
      seg.setAttribute('role', 'radiogroup');
      seg.setAttribute('aria-label', t('suggestion_mode_label'));
      const mk = (label, on) => {
        const b = el('button', 'share-composer__mode', label);
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.addEventListener('click', () => setMode(on));
        seg.appendChild(b);
        return b;
      };
      const bComment = mk(t('suggestion_mode_comment'), false);
      const bSuggest = mk(t('suggestion_mode_suggest'), true);
      sugg = el('textarea', 'share-composer__body share-composer__suggestion');
      sugg.rows = 3;
      sugg.maxLength = 4000;
      sugg.value = anchor.quote;
      sugg.setAttribute('aria-label', t('suggestion_text_label'));
      sugg.hidden = true;
      setMode = (on) => {
        suggest = on;
        bComment.setAttribute('aria-checked', on ? 'false' : 'true');
        bSuggest.setAttribute('aria-checked', on ? 'true' : 'false');
        bComment.classList.toggle('share-composer__mode--on', !on);
        bSuggest.classList.toggle('share-composer__mode--on', on);
        sugg.hidden = !on;
        ta.placeholder = on ? t('suggestion_reason_placeholder') : t('comment_form_body');
        if (on) setTimeout(() => sugg.focus(), 0);
      };
      card.appendChild(seg);
      card.appendChild(sugg);
    }
    const ta = el('textarea', 'share-composer__body');
    ta.rows = 4;
    ta.maxLength = 4000;
    ta.placeholder = t('comment_form_body');
    ta.setAttribute('aria-label', t('comment_form_body'));
    if (draft && draft.key === key) ta.value = draft.text;
    current = { key, ta };
    if (sugg) setMode(false);
    const actions = el('div', 'share-composer__actions');
    const submit = el('button', 'share-composer__submit', t('send'));
    submit.type = 'button';
    const cancel = el('button', 'share-composer__cancel', t('cancel'));
    cancel.type = 'button';
    const status = el('span', 'share-comments__status');
    status.setAttribute('role', 'status');
    actions.appendChild(submit);
    actions.appendChild(cancel);
    actions.appendChild(status);
    card.appendChild(ta);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    release = makeModal(overlay, card, title);
    setTimeout(() => ta.focus(), 30);

    cancel.addEventListener('click', closeComposer);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeComposer(); });
    submitOnModEnter(ta, () => submit.click());
    if (sugg) submitOnModEnter(sugg, () => submit.click());
    submit.addEventListener('click', async () => {
      const body = (ta.value || '').trim();
      const suggestion = suggest && sugg ? (sugg.value || '').trim() : '';
      if (suggest && (!suggestion || suggestion === anchor.quote.trim())) { status.textContent = t('suggestion_unchanged'); return; }
      if (!body && !suggestion) { status.textContent = t('form_empty'); return; }
      submit.disabled = true;
      if (ensureIdentity && !(await ensureIdentity())) { submit.disabled = false; ta.focus(); return; }
      // Name kommt global aus dem Identitäts-Chip (oben rechts) — kein Feld hier.
      const payload = { body, reader_name: savedName() };
      if (suggestion) payload.suggestion = suggestion;
      if (anchor) { payload.anchor_bid = anchor.bid; payload.anchor_quote = anchor.quote; payload.anchor_start = anchor.start; payload.anchor_end = anchor.end; }
      try {
        await postComment(payload);
        draft = null;
        current = null;
        closeComposer();
        await onPosted();
        // Bewusst KEIN Scroll auf den neuen Kommentar — der Leser bleibt an der
        // markierten Stelle stehen.
      } catch (e) {
        status.textContent = errorText(e, t);
        submit.disabled = false;
      }
    });
  }
  function closeComposer() {
    if (current) {
      const text = current.ta.value || '';
      draft = text.trim() ? { key: current.key, text } : (draft && draft.key === current.key ? null : draft);
      current = null;
    }
    const ex = document.getElementById('share-composer');
    if (ex) ex.remove();
    if (release) { release(); release = null; }
  }

  // Leser interagiert gerade (Composer offen oder Text markiert) → Live-Poll pausieren.
  function isBusy() {
    return !!document.getElementById('share-composer') || !selBtn.hidden;
  }

  return { closeComposer, isBusy };
}
