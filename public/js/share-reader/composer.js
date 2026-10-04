'use strict';
// Schwebender „Kommentieren"-Button an der Textselektion + Composer-Overlay
// (verankerte UND allgemeine Anmerkungen). Standalone-Widget im share-reader/-
// Muster (dom/identity/menu/theme/toc/diff/layout).
//
// Verankerung: charOffset (share-anchor.js, SSoT mit der Owner-Karte) bestimmt
// Start/Ende des markierten Quotes innerhalb des data-bid-Blocks.

import { charOffset } from '../share-anchor.js';
import { el, makeModal, submitOnModEnter } from './dom.js';

// deps:
//   t            → i18n-Lookup
//   article      → das Artikel-Element (#share-article)
//   postComment  → (payload) => Promise (POST /comment)
//   onPosted     → () => Promise (Threads neu laden)
//   savedName    → () => string|undefined (globaler Identitäts-Name)
export function setupComposer({ t, article, postComment, onPosted, savedName }) {
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
  function openComposer(anchor) {
    closeComposer();
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
    const ta = el('textarea', 'share-composer__body');
    ta.rows = 4;
    ta.maxLength = 4000;
    ta.placeholder = t('comment_form_body');
    ta.setAttribute('aria-label', t('comment_form_body'));
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
    submit.addEventListener('click', async () => {
      const body = (ta.value || '').trim();
      if (!body) { status.textContent = t('form_empty'); return; }
      submit.disabled = true;
      // Name kommt global aus dem Identitäts-Chip (oben rechts) — kein Feld hier.
      const payload = { body, reader_name: savedName() };
      if (anchor) { payload.anchor_bid = anchor.bid; payload.anchor_quote = anchor.quote; payload.anchor_start = anchor.start; payload.anchor_end = anchor.end; }
      try {
        await postComment(payload);
        closeComposer();
        await onPosted();
        // Bewusst KEIN Scroll auf den neuen Kommentar — der Leser bleibt an der
        // markierten Stelle stehen.
      } catch (e) {
        status.textContent = e.status === 429 ? t('comment_rate_limited') : t('form_error');
        submit.disabled = false;
      }
    });
  }
  function closeComposer() {
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
