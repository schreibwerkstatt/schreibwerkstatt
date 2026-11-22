'use strict';
// Server-gerendertes Markup der Pre-Auth-Seiten (Login, Passwort setzen,
// Passwort vergessen, Logout, Zugang verweigert).
//
// Diese Seiten laufen VOR dem SPA-Boot: kein Alpine, kein i18n-Bundle, nur
// Server-HTML mit minimalem Asset-Set (tokens + landing). Sie teilen sich
// darum eine Schale und eine Formular-Vorlage — die Passwort-Formen des
// ENV-Admin-Zugangs, des Demo-Zugangs und der lokalen Anmeldung unterscheiden
// sich nur in Endpoint und Beschriftung, und drei Kopien wuerden bei jeder
// Aenderung am Fehler-Handling auseinanderlaufen.

const altcha = require('../../lib/altcha');
const { tServer } = require('../../lib/i18n-server');

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function bodyLang(req) {
  const accept = String(req.headers['accept-language'] || '').toLowerCase();
  return accept.startsWith('en') ? 'en' : 'de';
}

/** Nur eigene, relative Ziele zulassen — `//host` waere ein Open Redirect. */
function safeReturnTo(raw, fallback = '/') {
  const s = typeof raw === 'string' ? raw : '';
  return s.startsWith('/') && !s.startsWith('//') ? s : fallback;
}

function renderPublicShell({ lang, title, mainHtml, scripts = '' }) {
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="/schreibwerkstatt_icon.svg">
<script src="/js/theme-init.js"></script>
<link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/landing.css">
<script defer src="/js/plausible-init.js"></script>
</head>
<body>
${mainHtml}
${scripts}</body></html>`;
}

/** Eine Seite mit Ueberschrift, Fliesstext und einem Knopf. */
function renderNotice(res, { lang, status = 200, title, body, ctaHref, ctaLabel }) {
  res.status(status);
  res.set('Cache-Control', 'no-store');
  res.send(renderPublicShell({
    lang,
    title,
    mainHtml: `<main class="public-shell">
  <header class="public-header">
    <h1>${title}</h1>
    <p class="public-sub">${body}</p>
  </header>
  <section class="public-actions">
    <a class="public-btn public-btn--primary" href="${escAttr(ctaHref)}">${ctaLabel}</a>
  </section>
</main>`,
  }));
}

const DENIED_REASONS = new Set(['suspended', 'deleted', 'notInvited']);

/** Status-Gates: 'suspended' / 'deleted' / 'notInvited' → 403. */
function renderDenied(res, lang, reasonKey) {
  const reason = DENIED_REASONS.has(reasonKey) ? reasonKey : 'notInvited';
  renderNotice(res, {
    lang,
    status: 403,
    title: tServer('auth.denied.title', lang),
    body: tServer(`auth.denied.${reason}`, lang),
    ctaHref: '/auth/logout',
    ctaLabel: tServer('auth.denied.cta', lang),
  });
}

/**
 * ALTCHA-Widget-Markup. Form-assoziiertes Custom-Element: der geloeste Wert
 * landet als Feld `altcha` in der FormData. Jede Form braucht ihre EIGENE
 * Instanz — das Element ist an genau eine Form gebunden, ein geteiltes Widget
 * wuerde nur in einer der FormData landen.
 */
function altchaWidget() {
  return altcha.isEnabled()
    ? '    <altcha-widget challenge="/altcha/challenge" name="altcha" auto="onload"></altcha-widget>\n'
    : '';
}

/**
 * Passwort-Formular. `endpoint` bekommt JSON und antwortet mit 2xx oder einem
 * `error_code`; die Fehlertexte reist das Markup als `data-msg-*` mit, weil
 * public/js/credential-login.js vor dem i18n-Bundle laeuft.
 */
function pwForm({ id, endpoint, heading, hint, emailLabel, passwordLabel, submitLabel, emailValue, returnTo = '/', extraHtml = '', t }) {
  return `  <form id="${id}" class="public-form" novalidate data-login-endpoint="${escAttr(endpoint)}" data-returnto="${escAttr(returnTo)}" data-msg-invalid="${escAttr(t('auth.login.errInvalid'))}" data-msg-rate-tpl="${escAttr(t('auth.login.errRateTpl'))}" data-msg-captcha="${escAttr(t('auth.login.errCaptcha'))}" data-msg-inactive="${escAttr(t('auth.login.errInactive'))}">
    <h2 class="public-form-title">${heading}</h2>
${hint ? `    <p class="public-sub">${hint}</p>\n` : ''}    <label><span>${emailLabel}</span><input type="email" name="email" required autocomplete="username"${emailValue ? ` value="${escAttr(emailValue)}"` : ''}></label>
    <label><span>${passwordLabel || t('auth.login.password')}</span><input type="password" name="password" required autocomplete="current-password"></label>
${altchaWidget()}    <div class="public-form-actions">
      <button type="submit" class="public-btn public-btn--primary">${submitLabel}</button>
    </div>
    <p class="public-msg public-msg--err" data-login-err hidden></p>
${extraHtml}  </form>
`;
}

module.exports = {
  escAttr, bodyLang, safeReturnTo,
  renderPublicShell, renderNotice, renderDenied,
  altchaWidget, pwForm,
};
