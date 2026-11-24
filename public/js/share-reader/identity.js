'use strict';
// Reader-Identität (persistent pro Browser) + Namens-Chip/Modal. Standalone.
// Der Name wird nicht pro Formular abgefragt, sondern einmal zentral gesetzt:
// beim ersten Absenden eines Beitrags (`ensureIdentity()`, Composer, Antwort,
// allgemeine Form, Fazit) öffnet ein Modal („Dein Name"), danach steht „Als
// <Name> · Ändern" im Optionen-Menü (⋯). Reine Leser sehen den Dialog nie.
// „Anonym bleiben" merkt sich den Verzicht für die Session (sessionStorage) und
// sendet anonym; Esc/Klick daneben bricht das Absenden ab.

import { el, makeModal } from './dom.js';

const RT_KEY = 'sw_share_reader_token';
const NAME_KEY = 'sw_share_reader_name';
const EMAIL_KEY = 'sw_share_reader_email';
const DISMISS_KEY = 'sw_share_name_dismissed';
// Dieselbe Regel wie der Server (lib/share-helpers.js#READER_EMAIL_RE): eine
// Adresse, die er ablehnt, darf hier nicht gespeichert werden — sie ginge mit
// jedem Beitrag mit und jeder Beitrag scheiterte an INVALID_EMAIL.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EMAIL_MAX = 200;
export function isValidEmail(e) { return !e || (e.length <= EMAIL_MAX && EMAIL_RE.test(e)); }

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
// Eine früher gespeicherte, ungültige Adresse gilt als nicht gesetzt — sonst
// blockierte sie jeden Beitrag bis zur Korrektur.
export function savedEmail() {
  let v = '';
  try { v = localStorage.getItem(EMAIL_KEY) || ''; } catch { return ''; }
  return isValidEmail(v) ? v : '';
}
export function rememberEmail(e) { try { if (e) localStorage.setItem(EMAIL_KEY, e); } catch {} }
export function forgetEmail() { try { localStorage.removeItem(EMAIL_KEY); } catch {} }
export function nameDismissed() { try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; } }
export function markNameDismissed() { try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch {} }
let releaseModal = null;
let pendingResolve = null; // offenes ensureIdentity(): true = absenden, false = abbrechen
let openModal = null;      // von setupIdentity gesetzt
export function closeNameModal(proceed = false) {
  const ex = document.getElementById('share-name-modal');
  if (ex) ex.remove();
  if (releaseModal) { releaseModal(); releaseModal = null; }
  if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(!!proceed); }
}

// Vor dem ersten Beitrag einmal nach dem Namen fragen. Resolved `true`, wenn
// abgesendet werden soll (Name gesetzt, schon vorhanden, oder „Anonym bleiben"),
// `false`, wenn der Leser den Dialog ohne Wahl schliesst (Esc, Klick daneben).
export async function ensureIdentity() {
  // Review: `identityKnown` wartet auf den Ladestand des Wählers — sonst ginge
  // der Dialog auch in einem Browser auf, der seinen Namen schon gewählt hat.
  const known = identityKnown ? await identityKnown() : (savedName() || nameDismissed());
  if (known || !openModal) return true;
  if (pendingResolve) closeNameModal(false);
  return new Promise((resolve) => {
    openModal();
    pendingResolve = resolve;
  });
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
    btn.addEventListener('click', () => (openModal || openNameModal)());
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
    try { emailInput.value = localStorage.getItem(EMAIL_KEY) || ''; } catch { emailInput.value = ''; }
    const emailHint = el('p', 'share-name-modal__hint', t('email_optional_hint'));
    const emailError = el('p', 'share-name-modal__error');
    emailError.setAttribute('role', 'alert');
    emailError.hidden = true;
    const actions = el('div', 'share-composer__actions');
    const save = el('button', 'share-composer__submit', t('name_modal_save'));
    save.type = 'button';
    const skip = el('button', 'share-composer__cancel', t('name_modal_skip'));
    skip.type = 'button';
    actions.appendChild(save);
    actions.appendChild(skip);
    card.appendChild(input);
    card.appendChild(emailInput);
    card.appendChild(emailError);
    card.appendChild(emailHint);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    releaseModal = makeModal(overlay, card, title);
    setTimeout(() => input.focus(), 30);

    function commit() {
      const n = (input.value || '').trim();
      const e = (emailInput.value || '').trim();
      if (!isValidEmail(e)) {
        emailError.textContent = t('email_invalid');
        emailError.hidden = false;
        emailInput.setAttribute('aria-invalid', 'true');
        emailInput.focus();
        return;
      }
      const prevN = savedName();
      const prevE = savedEmail();
      if (n) rememberName(n); else forgetName();
      if (e) rememberEmail(e); else forgetEmail();
      markNameDismissed();
      renderChip();
      closeNameModal(true);
      // Bisherige eigene Kommentare auf Name + Mail nachziehen (Server matcht über
      // reader_token), dann Threads neu laden.
      if ((n !== prevN || e !== prevE) && typeof onIdentityChange === 'function') onIdentityChange(n, e);
    }
    save.addEventListener('click', commit);
    // Enter während einer IME-Komposition bestätigt die Zeichenwahl, nicht das Feld.
    const isEnter = (e) => e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;
    input.addEventListener('keydown', (e) => { if (isEnter(e)) { e.preventDefault(); emailInput.focus(); } });
    emailInput.addEventListener('keydown', (e) => { if (isEnter(e)) { e.preventDefault(); commit(); } });
    emailInput.addEventListener('input', () => { emailError.hidden = true; emailInput.removeAttribute('aria-invalid'); });
    // „Anonym bleiben": Verzicht für die Session merken, ein wartender Beitrag
    // geht anonym raus. Klick daneben schliesst nur (ein wartender Beitrag bleibt
    // ungesendet im Formular).
    skip.addEventListener('click', () => { markNameDismissed(); closeNameModal(true); });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeNameModal(false); });
  }

  openModal = openNameModal;
  renderChip();
  rerenderChip = renderChip;
}

// Review-Link (share-reader/review.js): statt „Dein Name" waehlt der Leser
// seinen Namen aus der Reviewer-Liste. Der Waehler oeffnet seinen Dialog unter
// derselben ID (`share-name-modal`) und beendet ihn ueber closeNameModal — so
// bleiben Esc-Reihenfolge, Poll-Pause und ein wartender Beitrag unveraendert.
let rerenderChip = null;
let identityKnown = null; // Review: „hat dieser Browser einen Reviewer-Namen?"
export function setNameModalOpener(fn, known = null) {
  if (typeof fn === 'function') openModal = fn;
  if (typeof known === 'function') identityKnown = known;
}
export function registerNameModal(release) { releaseModal = release; }
export function refreshIdentityChip() { rerenderChip?.(); }
