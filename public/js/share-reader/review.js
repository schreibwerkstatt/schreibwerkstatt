'use strict';
// Review-Link im Share-Reader (docs/share-link.md → „Review-Modus"). Eigenständig
// wie feedback.js, liest #share-config selbst und tut nichts, wenn der Link kein
// Review-Link ist (`CFG.review` fehlt).
//
// Zwei Aufgaben:
//   1. Wer bin ich? Der Leser wählt seinen Namen aus der Reviewer-Liste, die der
//      Autor beim Anlegen eingetragen hat, oder trägt sich selbst ein — der Link
//      wird oft frei im Team geteilt (POST /review/claim). Der Wähler
//      ersetzt den freien „Dein Name"-Dialog (identity.js#setNameModalOpener),
//      auch vor dem ersten Beitrag — der Server kommentiert dann unter genau
//      diesem Namen, und der Reviewer-Filter der Owner-Leisten trifft.
//   2. «Review abschliessen» am Ende des Texts (Slot #share-feedback, an dem
//      sonst das Sterne-Fazit steht) mit optionaler Schlussnotiz.

import { el, makeModal } from './dom.js';
import { errorText } from './api.js';
import {
  readerToken, rememberName, markNameDismissed, closeNameModal,
  setNameModalOpener, registerNameModal, refreshIdentityChip,
} from './identity.js';

(function () {
  const cfgEl = document.getElementById('share-config');
  if (!cfgEl) return;
  let CFG;
  try { CFG = JSON.parse(cfgEl.textContent || '{}'); } catch { return; }
  if (!CFG.token || !CFG.review) return;
  const host = document.getElementById('share-feedback');
  const I18N = CFG.i18n || {};
  const t = (k, p) => {
    let s = I18N[k] || k;
    if (p) for (const [key, v] of Object.entries(p)) s = s.replace(`{${key}}`, v);
    return s;
  };
  const base = `/share/${encodeURIComponent(CFG.token)}`;
  const RT = readerToken();

  let reviewers = (CFG.review.reviewers || []).map(r => ({ ...r, done: false, claimed: false, mine: false }));
  let me = null;
  let ready = null; // Promise des ersten loadState — ensureIdentity wartet darauf

  async function send(path, payload) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, reader_token: RT }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(j.error_code || 'ERR'); e.status = res.status; throw e; }
    return j;
  }

  async function loadState() {
    try {
      const res = await fetch(`${base}/review?rt=${encodeURIComponent(RT)}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const j = await res.json();
      reviewers = Array.isArray(j.reviewers) ? j.reviewers : reviewers;
      me = j.me || null;
      if (me) { rememberName(me.name); markNameDismissed(); refreshIdentityChip(); }
    } catch { /* offline: Liste aus der Konfiguration */ }
  }

  // r = Eintrag der Liste ({ id }) oder freier Name ({ name }).
  async function claim(r) {
    const j = await send('/review/claim', r.id != null ? { reviewer_id: r.id } : { name: r.name });
    me = j.me;
    rememberName(me.name);
    markNameDismissed();
    refreshIdentityChip();
    await loadState();
    render();
    return me;
  }

  // Namens-Wähler als Dialog (vor dem ersten Beitrag und über „Ändern" im ⋯-Menü).
  function openPicker() {
    closeNameModal(false);
    const overlay = el('div', 'share-composer');
    overlay.id = 'share-name-modal';
    const card = el('div', 'share-composer__card');
    const title = el('h3', 'share-composer__title', t('review_pick_title'));
    card.appendChild(title);
    card.appendChild(el('p', 'share-name-modal__intro', t(reviewers.length ? 'review_pick_intro' : 'review_pick_intro_open')));
    card.appendChild(pickerList(async (r, status) => {
      try { await claim(r); closeNameModal(true); return true; }
      catch (e) { status.textContent = errorText(e, t); return false; }
    }));
    const actions = el('div', 'share-composer__actions');
    const cancel = el('button', 'share-composer__cancel', t('cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', () => closeNameModal(false));
    actions.appendChild(cancel);
    card.appendChild(actions);
    overlay.appendChild(card);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeNameModal(false); });
    document.body.appendChild(overlay);
    registerNameModal(makeModal(overlay, card, title));
    setTimeout(() => card.querySelector('.share-review__pick, .share-review__name')?.focus(), 30);
  }

  // Namen der Liste als Knöpfe, darunter das Feld zum Selbst-Eintragen. Ein Name,
  // den ein anderer Browser gewählt hat, trägt «vergeben» — wählbar bleibt er
  // (Laptop → Telefon), aber niemand übernimmt einen Kollegen aus Versehen.
  // onPick(r, status) → Promise<boolean> (true = erledigt).
  function pickerList(onPick) {
    const wrap = el('div', 'share-review__picker');
    const status = el('span', 'share-comments__status');
    status.setAttribute('role', 'status');
    const setBusy = (on) => wrap.querySelectorAll('button, input').forEach(x => { x.disabled = on; });
    const pick = async (r) => { setBusy(true); const ok = await onPick(r, status); setBusy(false); return ok; };

    if (reviewers.length) {
      const list = el('div', 'share-review__picks');
      for (const r of reviewers) {
        const b = el('button', 'share-review__pick' + (r.mine ? ' share-review__pick--mine' : ''), r.name);
        b.type = 'button';
        if (r.done) b.appendChild(el('span', 'share-review__pick-done', t('review_done_badge')));
        else if (r.claimed && !r.mine) b.appendChild(el('span', 'share-review__pick-taken', t('review_taken_badge')));
        b.addEventListener('click', () => pick({ id: r.id }));
        list.appendChild(b);
      }
      wrap.appendChild(list);
      wrap.appendChild(el('p', 'share-review__other', t('review_pick_other')));
    }
    const row = el('form', 'share-review__join');
    const input = el('input', 'share-composer__name share-review__name');
    input.type = 'text';
    input.maxLength = 80;
    input.autocomplete = 'name';
    input.placeholder = t('review_name_placeholder');
    input.setAttribute('aria-label', t('review_name_placeholder'));
    const join = el('button', 'share-composer__submit', t('review_join'));
    join.type = 'submit';
    row.appendChild(input);
    row.appendChild(join);
    row.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      if (await pick({ name })) input.value = '';
    });
    wrap.appendChild(row);
    wrap.appendChild(status);
    return wrap;
  }

  function clear() { while (host.firstChild) host.removeChild(host.firstChild); }

  function render() {
    if (!host) return;
    host.hidden = false;
    host.classList.add('share-review');
    clear();
    host.appendChild(el('h2', 'share-feedback__heading', t('review_heading')));
    if (!me) {
      host.appendChild(el('p', 'share-feedback__intro', t(reviewers.length ? 'review_pick_intro' : 'review_pick_intro_open')));
      host.appendChild(pickerList(async (r, status) => {
        try { await claim(r); return true; } catch (e) { status.textContent = errorText(e, t); return false; }
      }));
      return;
    }
    const meRow = reviewers.find(r => r.id === me.id) || me;
    const who = el('p', 'share-feedback__intro', t('review_as', { name: me.name }));
    const change = el('button', 'share-identity-bar__btn', t('change_name'));
    change.type = 'button';
    change.addEventListener('click', openPicker);
    who.appendChild(document.createTextNode(' '));
    who.appendChild(change);
    host.appendChild(who);

    const status = el('span', 'share-comments__status');
    status.setAttribute('role', 'status');
    if (meRow.done) {
      host.appendChild(el('p', 'share-review__done', t('review_done_msg')));
      const reopen = el('button', 'share-composer__cancel', t('review_reopen'));
      reopen.type = 'button';
      reopen.addEventListener('click', async () => {
        reopen.disabled = true;
        try { await send('/review/done', { done: false }); await loadState(); render(); }
        catch { status.textContent = t('form_error'); reopen.disabled = false; }
      });
      host.appendChild(reopen);
      host.appendChild(status);
      return;
    }
    host.appendChild(el('p', 'share-feedback__intro', t('review_finish_intro')));
    const note = el('textarea', 'share-feedback__comment');
    note.rows = 3;
    note.maxLength = 4000;
    note.placeholder = t('review_note_placeholder');
    note.setAttribute('aria-label', t('review_note_placeholder'));
    host.appendChild(note);
    const actions = el('div', 'share-feedback__actions');
    const finish = el('button', 'share-feedback__submit', t('review_finish'));
    finish.type = 'button';
    finish.addEventListener('click', async () => {
      finish.disabled = true;
      try {
        await send('/review/done', { done: true, note: note.value || '' });
        await loadState();
        render();
      } catch {
        status.textContent = t('form_error');
        finish.disabled = false;
      }
    });
    actions.appendChild(finish);
    actions.appendChild(status);
    host.appendChild(actions);
  }

  // Wähler statt freiem Namen; „bekannt" ist ein Browser erst mit Anspruch.
  ready = loadState();
  setNameModalOpener(openPicker, async () => { await ready; return !!me; });
  ready.then(render);
})();
