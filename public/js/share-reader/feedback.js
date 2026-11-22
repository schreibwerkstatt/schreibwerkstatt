'use strict';
// Gesamt-Fazit für den Share-Reader: Sternewertung (1-5) + optionaler Freitext,
// einmal pro Leser (reader_token, serverseitig UPSERT). Eigenständiges Modul
// (kein Alpine), liest #share-config selbst — analog dwell.js. Am Ende der
// Leseansicht (#share-feedback). Prefill aus dem eigenen bereits abgegebenen
// Fazit. Teilt reader_token, Namen und die Namensabfrage vor dem ersten Beitrag
// mit der Kommentar-Identität (share-reader/identity.js, eine Modul-Instanz).
// JS-enhanced (kein SSR-Fallback) — sekundäres Feature; die Kommentar-Form
// funktioniert weiterhin ohne JS.

import { readerToken, savedName, ensureIdentity } from './identity.js';

(function () {
  const host = document.getElementById('share-feedback');
  if (!host) return;
  const cfgEl = document.getElementById('share-config');
  if (!cfgEl) return;
  let CFG;
  try { CFG = JSON.parse(cfgEl.textContent || '{}'); } catch { return; }
  const TOKEN = CFG.token;
  if (!TOKEN) return;
  const I18N = CFG.i18n || {};
  const t = (k) => I18N[k] || k;

  const RT = readerToken();

  host.hidden = false;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear() { while (host.firstChild) host.removeChild(host.firstChild); }
  function heading() { host.appendChild(el('h2', 'share-feedback__heading', t('feedback_heading'))); }

  function renderForm(prefill) {
    clear();
    heading();
    host.appendChild(el('p', 'share-feedback__intro', t('feedback_intro')));

    let current = prefill ? (prefill.rating || 0) : 0;
    const stars = el('div', 'share-feedback__stars');
    stars.setAttribute('role', 'radiogroup');
    stars.setAttribute('aria-label', t('feedback_rating_label'));
    const starBtns = [];
    function paint(n) {
      starBtns.forEach((b, i) => {
        const on = i < n;
        b.classList.toggle('share-feedback__star--on', on);
        b.setAttribute('aria-checked', i + 1 === current ? 'true' : 'false');
        b.textContent = on ? '★' : '☆';
      });
    }
    for (let i = 1; i <= 5; i++) {
      const b = el('button', 'share-feedback__star');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', t('feedback_star').replace('{n}', i));
      b.addEventListener('click', () => { current = i; paint(i); submit.disabled = false; });
      b.addEventListener('mouseenter', () => paint(i));
      b.addEventListener('mouseleave', () => paint(current));
      starBtns.push(b);
      stars.appendChild(b);
    }
    host.appendChild(stars);

    const ta = el('textarea', 'share-feedback__comment');
    ta.placeholder = t('feedback_comment_placeholder');
    ta.maxLength = 4000;
    if (prefill && prefill.body) ta.value = prefill.body;
    host.appendChild(ta);

    const actions = el('div', 'share-feedback__actions');
    const submit = el('button', 'share-feedback__submit', prefill ? t('feedback_update') : t('feedback_submit'));
    submit.type = 'button';
    submit.disabled = !current;
    const status = el('span', 'share-feedback__status');
    actions.appendChild(submit);
    actions.appendChild(status);
    host.appendChild(actions);
    paint(current);

    submit.addEventListener('click', async () => {
      if (!current) return;
      submit.disabled = true;
      status.textContent = '';
      if (!(await ensureIdentity())) { submit.disabled = false; return; }
      try {
        const res = await fetch(`/share/${encodeURIComponent(TOKEN)}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reader_token: RT, reader_name: savedName(), rating: current, body: (ta.value || '').trim() }),
        });
        if (!res.ok) throw new Error('ERR');
        renderThanks({ rating: current, body: (ta.value || '').trim() });
      } catch {
        status.textContent = t('feedback_error');
        submit.disabled = false;
      }
    });
  }

  function renderThanks(fb) {
    clear();
    heading();
    const wrap = el('div', 'share-feedback__thanks');
    wrap.appendChild(el('span', null, t('feedback_thanks')));
    const stars = el('span', 'share-feedback__stars');
    stars.setAttribute('aria-hidden', 'true');
    for (let i = 1; i <= 5; i++) {
      stars.appendChild(el('span', i <= fb.rating ? 'share-feedback__star share-feedback__star--on' : 'share-feedback__star', i <= fb.rating ? '★' : '☆'));
    }
    wrap.appendChild(stars);
    const change = el('button', 'share-feedback__change', t('feedback_change'));
    change.type = 'button';
    change.addEventListener('click', () => renderForm(fb));
    wrap.appendChild(change);
    host.appendChild(wrap);
  }

  (async () => {
    try {
      const res = await fetch(`/share/${encodeURIComponent(TOKEN)}/feedback/mine?rt=${encodeURIComponent(RT)}`, { headers: { 'Accept': 'application/json' } });
      const j = res.ok ? await res.json() : {};
      if (j.feedback) renderThanks(j.feedback);
      else renderForm(null);
    } catch { renderForm(null); }
  })();
})();
