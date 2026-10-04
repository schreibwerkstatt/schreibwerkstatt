'use strict';
// Mobile-Bottom-Sheet für einen verankerten Thread. Unter 1100px stehen die
// Anmerkungen als Liste unter dem Artikel — bei einem Buch-Share also am Ende
// des ganzen Buchs. Ein Tipp auf eine markierte Stelle öffnet den Thread darum
// hier über der Lesestelle, statt den Leser ans Ende zu scrollen.

import { el, makeModal } from './dom.js';

// deps:
//   t
//   renderThread(node) → <li>-Karte (thread-render.js)
//   onClose()          → nach dem Schliessen (Auswahl aufheben)
export function createThreadSheet({ t, renderThread, onClose }) {
  let overlay = null;
  let list = null;
  let openId = null;
  let release = null;

  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    list = null;
    openId = null;
    if (release) { release(); release = null; }
    if (typeof onClose === 'function') onClose();
  }

  function fill(node) {
    list.innerHTML = '';
    list.appendChild(renderThread(node));
  }

  function open(node) {
    if (!node) return;
    if (overlay && openId === node.root.id) return;
    close();
    openId = node.root.id;
    overlay = el('div', 'share-composer share-sheet');
    overlay.id = 'share-sheet';
    const card = el('div', 'share-composer__card share-sheet__card');
    const head = el('div', 'share-sheet__head');
    const title = el('h3', 'share-composer__title', t('threads_heading'));
    const closeBtn = el('button', 'share-sheet__close', '×');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', t('close'));
    closeBtn.title = t('close');
    head.appendChild(title);
    head.appendChild(closeBtn);
    list = el('ol', 'share-sheet__list');
    card.appendChild(head);
    card.appendChild(list);
    overlay.appendChild(card);
    fill(node);
    document.body.appendChild(overlay);
    release = makeModal(overlay, card, title);
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    setTimeout(() => closeBtn.focus(), 30);
  }

  // Nach einem Re-Render (Poll, eigene Aktion) den offenen Thread nachziehen;
  // verschwunden (gelöscht) → Sheet schliessen.
  function refresh(threadById) {
    if (!overlay) return;
    const node = threadById(openId);
    if (!node) { close(); return; }
    fill(node);
  }

  return { open, close, refresh, isOpen: () => !!overlay };
}
