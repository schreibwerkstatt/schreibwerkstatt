// Alpine-Direktive `x-user-chip` — Personen-Chip (Initialen-Bubble + Name) an
// einem Ort. Konsument: `<span x-user-chip="rev.user_email"></span>`, Element
// leer. Die Direktive setzt `.user-chip` (+ `--self` fuer den angemeldeten
// User), den Tooltip (E-Mail), die Avatar-Farbe und den Namen («Du» fuer sich
// selbst, sonst der Anzeigename). Ohne E-Mail bleibt das Element verborgen.
// Optik: components/user-chip.css. Regel + Gate: DESIGN.md «Personen-Chip».
//
// Reaktiv ueber Alpines `effect`: Anzeigename (laedt `/me/users-light` lazy
// am Root nach), Sprache und angemeldeter User ziehen den Chip nach.

import { tRaw } from './i18n.js';

function isSelf(email) {
  const me = window.Alpine?.store('session')?.currentUser?.email;
  return !!me && !!email && String(me).toLowerCase() === String(email).toLowerCase();
}

function render(el, email) {
  el.classList.add('user-chip');
  el.hidden = !email;
  if (!email) { el.replaceChildren(); return; }
  const app = window.__app;
  const self = isSelf(email);
  el.classList.toggle('user-chip--self', self);
  el.setAttribute('data-tip', email);
  const avatar = document.createElement('span');
  avatar.className = 'user-chip__avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.style.setProperty('--avatar-hue', String(app?.userAvatarHue?.(email) ?? ''));
  avatar.textContent = app?.userInitials?.(email) || '?';
  const name = document.createElement('span');
  name.className = 'user-chip__name';
  name.textContent = self ? (app?.t?.('userChip.self') || tRaw('userChip.self')) : (app?.userDisplayName?.(email) || email);
  el.replaceChildren(avatar, name);
}

export function registerUserChip() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.directive('user-chip', (el, { expression }, { evaluateLater, effect }) => {
    const get = evaluateLater(expression);
    effect(() => { get((email) => render(el, email ? String(email) : '')); });
  });
}
