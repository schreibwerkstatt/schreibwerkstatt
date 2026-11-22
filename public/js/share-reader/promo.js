'use strict';
// Einmaliger App-Hinweis nach dem ersten abgeschickten Kommentar (Share-Reader).
// Eigenständiges Modul (kein Alpine), liest #share-config selbst. Aktiv nur,
// wenn der Link den Promo-Schalter an hat (`promo` im Config, Server:
// lib/share-promo.js — dort auch die fertigen, lokalisierten Texte + Link mit
// `?ref=share-comment`). Auslöser ist das Event `share:comment-posted`, das
// share-reader/api.js nach jedem erfolgreichen POST /comment feuert (Composer,
// Antwort, allgemeines Formular). Einmal pro Browser: localStorage-Flag, auch
// wenn der Hinweis nur weggeklickt wurde. Ohne Storage (privates Fenster,
// gesperrt) erscheint er höchstens einmal pro Seitenaufruf.

import { EVT } from '../events.js';

(function () {
  const cfgEl = document.getElementById('share-config');
  let promo = null;
  if (cfgEl) { try { promo = JSON.parse(cfgEl.textContent || '{}').promo || null; } catch { promo = null; } }
  if (!promo || !promo.url) return;

  const KEY = 'sw_share_promo_seen';
  let shownThisPage = false;
  function seen() {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  }
  function markSeen() {
    try { localStorage.setItem(KEY, '1'); } catch { /* Storage gesperrt */ }
  }

  function show() {
    const box = document.createElement('aside');
    box.className = 'share-promo';
    box.setAttribute('role', 'status');

    const head = document.createElement('div');
    head.className = 'share-promo__head';
    const title = document.createElement('p');
    title.className = 'share-promo__title';
    title.textContent = promo.title || '';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'share-promo__close';
    close.textContent = '×';
    close.setAttribute('aria-label', promo.close || 'Close');
    close.title = promo.close || 'Close';
    head.appendChild(title);
    head.appendChild(close);

    const body = document.createElement('p');
    body.className = 'share-promo__body';
    body.textContent = promo.body || '';
    const link = document.createElement('a');
    link.className = 'share-promo__link';
    link.href = promo.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = `→ ${promo.link || ''}`;
    body.appendChild(document.createTextNode(' '));
    body.appendChild(link);

    box.appendChild(head);
    box.appendChild(body);
    document.body.appendChild(box);
    close.addEventListener('click', () => box.remove());
    link.addEventListener('click', () => box.remove());
  }

  document.addEventListener(EVT.SHARE_COMMENT_POSTED, () => {
    if (shownThisPage || seen()) return;
    shownThisPage = true;
    markSeen();
    show();
  });
})();
