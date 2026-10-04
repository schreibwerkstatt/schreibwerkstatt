'use strict';
// Reader-Identität (persistent pro Browser) + Namens-Chip/Modal. Standalone.
// Der Name wird nicht pro Formular abgefragt, sondern einmal zentral gesetzt:
// beim ersten Laden öffnet ein Modal („Dein Name"), danach steht „Als <Name> ·
// Ändern" im Optionen-Menü (⋯). Composer, Reply-Form und SSR-Form kommentieren
// mit dem hier gesetzten Namen (sonst anonym). „Überspringen"/Outside-Click
// merkt sich den Verzicht für die Session (sessionStorage).

import { el, makeModal } from './dom.js';

const RT_KEY = 'sw_share_reader_token';
const NAME_KEY = 'sw_share_reader_name';
const EMAIL_KEY = 'sw_share_reader_email';
const DISMISS_KEY = 'sw_share_name_dismissed';

export function readerToken() {
  let v = '';
  try { v = localStorage.getItem(RT_KEY) || ''; } catch {}
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(v)) {
    const a = new Uint8Array(16);
    (crypto.getRandomValues ? crypto.getRandomValues(a) : a.fill(0));
    v = 'r' + Array.from(a, b => (b % 36).toString(36)).join('');
    try { localStorage.setItem(RT_KEY, v); } catch {}
  }
  return v;
}
export function savedName() { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } }
export function rememberName(n) { try { if (n) localStorage.setItem(NAME_KEY, n); } catch {} }
export function forgetName() { try { localStorage.removeItem(NAME_KEY); } catch {} }
export function savedEmail() { try { return localStorage.getItem(EMAIL_KEY) || ''; } catch { return ''; } }
export function rememberEmail(e) { try { if (e) localStorage.setItem(EMAIL_KEY, e); } catch {} }
export function forgetEmail() { try { localStorage.removeItem(EMAIL_KEY); } catch {} }
export function nameDismissed() { try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } }
export function markNameDismissed() { try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch {} }
let releaseModal = null;
export function closeNameModal() {
  const ex = document.getElementById('share-name-modal');
  if (ex) ex.remove();
  if (releaseModal) { releaseModal(); releaseModal = null; }
}

// Identitäts-Chip (in den Optionen-Menü-Cluster via menuSection) + Identitäts-
// Modal (Name + optionale Mail). `onIdentityChange(name, email)` wird bei
// tatsächlicher Änderung aufgerufen, damit die Facade die bisherigen eigenen
// Kommentare auf Name + Mail nachzieht. Die Mail ist optional und dient nur der
// Benachrichtigung, wenn der Autor auf einen Thread antwortet.
export function setupIdentity({ t, menuSection, onIdentityChange }) {
  const sec = menuSection();
  const chip = el('div', 'share-identity-bar');
  sec.appendChild(chip);

  function renderChip() {
    chip.innerHTML = '';
    const name = savedName();
    if (name) chip.appendChild(el('span', 'share-identity-bar__as', t('comment_as').replace('{name}', name)));
    if (savedEmail()) {
      const bell = el('span', 'share-identity-bar__bell', t('email_notice_on'));
      bell.title = t('email_notice_on');
      chip.appendChild(bell);
    }
    const btn = el('button', 'share-identity-bar__btn', name ? t('change_name') : t('set_name'));
    btn.type = 'button';
    btn.addEventListener('click', () => openNameModal());
    chip.appendChild(btn);
  }

  function openNameModal() {
    closeNameModal();
    const overlay = el('div', 'share-composer');
    overlay.id = 'share-name-modal';
    const card = el('div', 'share-composer__card');
    const title = el('h3', 'share-composer__title', t('name_modal_title'));
    card.appendChild(title);
    card.appendChild(el('p', 'share-name-modal__intro', t('name_modal_intro')));
    const input = el('input', 'share-composer__name');
    input.type = 'text';
    input.maxLength = 80;
    input.placeholder = t('your_name');
    input.setAttribute('aria-label', t('your_name'));
    input.value = savedName();
    const emailInput = el('input', 'share-composer__name');
    emailInput.type = 'email';
    emailInput.maxLength = 200;
    emailInput.placeholder = t('name_modal_email');
    emailInput.setAttribute('aria-label', t('name_modal_email'));
    emailInput.value = savedEmail();
    const emailHint = el('p', 'share-name-modal__hint', t('email_optional_hint'));
    const actions = el('div', 'share-composer__actions');
    const save = el('button', 'share-composer__submit', t('name_modal_save'));
    save.type = 'button';
    const skip = el('button', 'share-composer__cancel', t('name_modal_skip'));
    skip.type = 'button';
    actions.appendChild(save);
    actions.appendChild(skip);
    card.appendChild(input);
    card.appendChild(emailInput);
    card.appendChild(emailHint);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    releaseModal = makeModal(overlay, card, title);
    setTimeout(() => input.focus(), 30);

    function commit() {
      const n = (input.value || '').trim();
      const e = (emailInput.value || '').trim();
      const prevN = savedName();
      const prevE = savedEmail();
      if (n) rememberName(n); else forgetName();
      if (e) rememberEmail(e); else forgetEmail();
      markNameDismissed();
      renderChip();
      closeNameModal();
      // Bisherige eigene Kommentare auf Name + Mail nachziehen (Server matcht über
      // reader_token), dann Threads neu laden.
      if ((n !== prevN || e !== prevE) && typeof onIdentityChange === 'function') onIdentityChange(n, e);
    }
    save.addEventListener('click', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); emailInput.focus(); } });
    emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    skip.addEventListener('click', () => { markNameDismissed(); closeNameModal(); });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) { markNameDismissed(); closeNameModal(); } });
  }

  renderChip();
  // Auto-Öffnen beim ersten Laden, solange kein Name gesetzt und nicht in
  // dieser Session weggeklickt.
  if (!savedName() && !nameDismissed()) openNameModal();
}
