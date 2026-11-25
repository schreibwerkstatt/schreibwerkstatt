// Alpine-Direktive `x-job-progress` — Fortschritt eines laufenden Jobs an einem
// Ort: Balken, Statuszeile, «Abbrechen». Konsument, Element leer:
//
//   <div x-job-progress="{ active: apGenerating, progress: apGenProgress,
//                          status: apGenStatus, timer: '_apPollTimer' }"></div>
//
// Spec (wird bei jeder Änderung neu ausgewertet):
//   active    — läuft der Job (Balken + Abbrechen nur dann).
//   progress  — 0–100; Balken erst ab > 0.
//   status    — Statuszeile als vorab escaptes HTML (runningJobStatus,
//               statusHtml, escHtml — dieselbe Invariante wie x-html).
//   text      — Statuszeile als Klartext; statt `status`, wenn der Wert nicht
//               escaped ist.
//   fallback  — i18n-Key für die Statuszeile, solange aktiv und noch leer.
//   timer     — timerProp des startPoll-Pollers; Abbrechen holt die Job-ID
//               daraus (polledJobId) und ruft `$app.cancelJob`.
//   cancel    — eigene Abbruch-Funktion (statt `timer`), z. B. wenn die Karte
//               die Job-ID selbst führt oder vorher eigenen State räumt.
//   error     — true: Statuszeile als Fehler (`card-status--error`).
//
// Sichtbar, solange der Job läuft oder eine Statuszeile steht (Ergebnis,
// Fehler, «abgebrochen»). Optik: `.job-progress` in card-blocks.css.
// Regel + Gate: DESIGN.md «KI-Lauf verfolgen» / «Karten-Innenraum», tests/unit/job-progress-single-place.test.mjs.

import { polledJobId } from './cards/job-helpers.js';

function t(key, params) {
  return window.__app?.t?.(key, params) ?? key;
}

function build(el) {
  el.classList.add('job-progress');
  const wrap = document.createElement('div');
  wrap.className = 'progress-bar-wrap';
  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  wrap.append(bar);
  const row = document.createElement('div');
  row.className = 'job-progress-row';
  const status = document.createElement('div');
  status.className = 'card-status';
  status.setAttribute('role', 'status');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-compact btn-compact--ghost job-progress-cancel';
  row.append(status, btn);
  el.replaceChildren(wrap, row);
  return { wrap, bar, status, btn };
}

export function registerJobProgress() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.directive('job-progress', (el, { expression }, { evaluateLater, effect }) => {
    const get = evaluateLater(expression);
    const parts = build(el);
    let spec = {};
    let cancelling = false;

    const cancelFn = () => {
      if (typeof spec.cancel === 'function') return spec.cancel;
      if (!spec.timer) return null;
      const data = window.Alpine.$data(el);
      const jobId = polledJobId(data, spec.timer);
      return jobId ? () => window.__app?.cancelJob?.(jobId) : null;
    };

    parts.btn.addEventListener('click', async () => {
      const fn = cancelFn();
      if (!fn || cancelling) return;
      cancelling = true;
      parts.btn.disabled = true;
      // Gescheiterter Abbruch (Netzfehler, `cancelJob` → false): der Job läuft
      // weiter, also muss «Abbrechen» wieder greifen. Erfolg hält den Knopf
      // gesperrt, bis `active` fällt.
      let ok = false;
      try { ok = (await fn()) !== false; } catch (e) { console.error('[job-progress cancel]', e); }
      if (!ok) {
        cancelling = false;
        parts.btn.disabled = false;
      }
    });

    effect(() => {
      get((value) => {
        spec = value || {};
        const active = !!spec.active;
        if (!active) cancelling = false;
        const pct = Number(spec.progress) || 0;
        const html = spec.status ? String(spec.status) : '';
        const text = spec.text ? String(spec.text) : '';
        const fallback = active && !html && !text && spec.fallback ? t(spec.fallback) : '';

        if (html) parts.status.innerHTML = html;
        else parts.status.textContent = text || fallback;
        const hasStatus = !!(html || text || fallback);
        parts.status.hidden = !hasStatus;
        parts.status.classList.toggle('card-status--error', !!spec.error);

        parts.wrap.hidden = !(active && pct > 0);
        parts.bar.style.setProperty('--progress', `${Math.max(0, Math.min(100, pct))}%`);

        const canCancel = active && !!(typeof spec.cancel === 'function' || spec.timer);
        parts.btn.hidden = !canCancel;
        parts.btn.disabled = cancelling;
        parts.btn.textContent = t('common.cancel');
        parts.btn.setAttribute('data-tip', t('chat.cancelRunTip'));

        el.hidden = !(active || hasStatus);
      });
    });
  });
}
