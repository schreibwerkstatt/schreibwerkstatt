'use strict';
// Auto-Hide-Scrollbar für interne Scroll-Container: hängt `.is-scrolling` an,
// solange gescrollt wird, und entfernt es nach kurzer Idle-Zeit. Das CSS hält
// den Thumb standardmässig transparent (Gutter via `scrollbar-width: thin`
// reserviert → kein Layout-Shift) und färbt ihn nur unter `.is-scrolling` ein.
//
// Geteilt zwischen SPA (Sidebar-Tree, Bucheditor-Inhaltsverzeichnis, horizontal
// scrollende Boards: Plot-Werkstatt + Recherche-Status — dort neutralisiert das
// CSS unter `.is-scrolling` den Hover-Lift der Karten, die unter dem stehenden
// Cursor durchgleiten) und der SSR-Share-Reader-View (TOC + Kommentar-Leiste).
// Idempotent pro Element.
export function bindScrollFade(el, { idleMs = 800 } = {}) {
  if (!el || el._scrollFadeBound) return;
  el._scrollFadeBound = true;
  let idleTimer = null;
  el.addEventListener('scroll', () => {
    el.classList.add('is-scrolling');
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => el.classList.remove('is-scrolling'), idleMs);
  }, { passive: true });
}
