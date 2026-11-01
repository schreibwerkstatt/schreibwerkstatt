'use strict';
// Anmelde-Verfahren „Lokal" (E-Mail + Passwort in dieser Instanz).
//
// Vertrag eines Verfahrens: siehe ./index.js. Existenzgrund: eine self-hosted
// Instanz soll ohne fremden Identitaetsanbieter auskommen.
//
// Endpunkte:
//   POST /auth/local-login   — Anmeldung (geteilter Kern in ../credential-login.js)
//   GET  /auth/password      — Setz-Seite (aus Einladung, Setz-Link oder Reset-Link)
//   POST /auth/password      — Passwort setzen + Sitzung eroeffnen
//   GET  /auth/forgot        — „Passwort vergessen"-Formular
//   POST /auth/forgot        — Reset-Link anfordern (antwortet IMMER gleich)
//
// Drei Wege fuehren auf dieselbe Setz-Seite, und sie unterscheiden sich in
// genau einem Punkt: ob das Konto schon existiert.
//   `?invite=<token>`  — Einladung, Konto wird beim Setzen angelegt
//   `?token=<token>`   — Setz-/Reset-Link an ein bestehendes Konto
// Der dritte Weg ist das vom Admin vergebene Initialpasswort: die Anmeldung
// gelingt, eroeffnet aber keine Sitzung, sondern mintet ein kurzlebiges Token
// und schickt auf `?token=…`. Bewusst KEINE halb angemeldete Sitzung — die
// muesste der Auth-Guard danach global wieder einfangen, und jede Route, die
// das vergisst, waere ein offenes Konto.

const express = require('express');
const logger = require('../../../logger');
const appUsers = require('../../../db/app-users');
const { recordUsageEvent } = require('../../../lib/usage-events');
const creds = require('../../../db/user-credentials');
const appSettings = require('../../../lib/app-settings');
const password = require('../../../lib/password');
const mailer = require('../../../lib/mailer');
const altcha = require('../../../lib/altcha');
const rateLimit = require('../../../lib/admin-login-ratelimit');
const { absoluteUrl } = require('../../../lib/public-url');
const { tServer, tServerParams } = require('../../../lib/i18n-server');
const { credentialLogin, clientIp, establishSession } = require('../credential-login');
const { asyncRoute } = require('../async-route');
const {
  escAttr, bodyLang, safeReturnTo, renderPublicShell, renderNotice, pwForm, altchaWidget,
} = require('../render');

const ID = 'local';

function _escParams(params) {
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, escAttr(v)]));
}

function tokenTtlHours() {
  const v = appSettings.get('auth.local.token_ttl_hours');
  return Number.isInteger(v) ? v : 48;
}

function selfResetEnabled() {
  return appSettings.get('auth.local.allow_self_reset') === true;
}

/**
 * Konfiguriert ist das Verfahren immer — es braucht keinen fremden Dienst.
 * Ohne Mailer fehlen nur die Link-Wege; das Initialpasswort des Admins traegt
 * dann allein, und genau dafuer gibt es ihn.
 */
function isConfigured() {
  return true;
}

/** Absoluter Link auf die Setz-Seite (fuer Mails). */
function passwordUrl(token) {
  return absoluteUrl(`/auth/password?token=${encodeURIComponent(token)}`);
}

/**
 * Setz-/Reset-Link ausstellen und per Mail schicken.
 * Liefert `{ token, url, mail }` — der Admin-Pfad zeigt die URL an, wenn kein
 * Mailer konfiguriert ist.
 */
async function issuePasswordLink(email, { purpose = 'set', createdBy = null, locale = 'de' } = {}) {
  const { token, expiresAt } = creds.createToken(email, {
    purpose, ttlHours: tokenTtlHours(), createdBy,
  });
  const url = passwordUrl(token);
  let mail = { sent: false, reason: 'not-attempted' };
  try {
    mail = await mailer.send({
      to: email,
      template: purpose === 'reset' ? 'password-reset' : 'password-set',
      locale,
      ctx: { passwordUrl: url, expiresAt },
    });
  } catch (e) {
    mail = { sent: false, reason: 'error', error: e.message };
  }
  return { token, url, expiresAt, mail };
}

// ── POST /auth/local-login ─────────────────────────────────────────────────

const router = express.Router();

router.post('/auth/local-login', express.json(), credentialLogin({
  disabledCode: 'LOCAL_LOGIN_DISABLED',
  isEnabled: () => true, // Gate sitzt im Registry-Mount (nur das aktive Verfahren laeuft)
  method: 'local',
  logLabel: 'Login (lokal)',
  authenticate: async ({ email, password: given, req }) => {
    const row = creds.getCredential(email);
    // Unbekanntes Konto: trotzdem eine Verifikation gegen einen festen Dummy-
    // Hash rechnen. Ohne das antwortet der Server auf eine nicht existierende
    // Adresse messbar schneller und verraet damit, welche Konten es gibt.
    if (!row) {
      await password.verifyPassword(given || '', DUMMY_HASH);
      return { ok: false };
    }
    if (!(await password.verifyPassword(given, row.password_hash))) return { ok: false };

    const user = appUsers.getUser(email);
    if (!user) return { ok: false };
    if (user.status === 'suspended' || user.status === 'deleted') {
      return { ok: true, denied: user.status };
    }

    // Vom Admin vergebenes Initialpasswort: gueltig genau einmal, und zwar zum
    // Setzen eines eigenen. Das kurzlebige Token traegt den Wechsel, nicht die
    // Sitzung.
    if (row.must_change) {
      const { token } = creds.createToken(email, { purpose: 'set', ttlHours: 1 });
      return { ok: true, redirect: `/auth/password?token=${encodeURIComponent(token)}`, reason: 'must-change' };
    }

    // Kostenparameter des Hashs sind ueberholt → beim erfolgreichen Login neu
    // rechnen. Nur hier moeglich, weil nur hier das Klartext-Passwort vorliegt.
    if (password.needsRehash(row.password_hash)) {
      try {
        creds.setPassword(email, await password.hashPassword(given), { mustChange: 0, updatedBy: null });
      } catch (e) {
        logger.warn(`Rehash fehlgeschlagen: ${e.message}`, { user: email });
      }
    }
    void req;
    return { ok: true, role: user.global_role, name: user.display_name || email };
  },
}));

// Fester Vergleichs-Hash fuer unbekannte Konten (siehe oben). Einmal beim Laden
// gerechnet; der Klartext ist bedeutungslos und nirgends gueltig.
let DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA';
password.hashPassword('unused-timing-equalizer')
  .then(h => { DUMMY_HASH = h; })
  .catch(() => { /* Fallback-String bleibt; verifyPassword liefert dann false */ });

// ── Setz-Seite ─────────────────────────────────────────────────────────────

/**
 * Loest die beiden Token-Arten auf eine gemeinsame Form auf.
 * Liefert `{ email, kind: 'invite'|'token', token, displayName?, inviteId? }`
 * oder null, wenn nichts Gueltiges vorliegt.
 */
function resolveTicket({ inviteToken, token }) {
  if (inviteToken) {
    const inv = appUsers.findInviteByToken(inviteToken);
    if (!inv || appUsers.inviteStatus(inv) !== 'active') return null;
    return { email: inv.email, kind: 'invite', token: inviteToken, invite: inv };
  }
  if (token) {
    const row = creds.findValidToken(token);
    if (!row) return null;
    const user = appUsers.getUser(row.user_email);
    if (!user || user.status === 'deleted' || user.status === 'suspended') return null;
    return { email: row.user_email, kind: 'token', token, row, user };
  }
  return null;
}

function renderPasswordPage(req, res, { ticket, lang }) {
  // Platzhalter-Werte werden escaped, bevor sie ins Markup gehen — `email`
  // stammt aus der DB und nicht aus einer Konstanten.
  const t = (k, p) => (p ? tServerParams(k, _escParams(p), lang) : tServer(k, lang));
  const title = t('auth.password.title');
  const needsName = ticket.kind === 'invite';
  const nameField = needsName
    ? `    <label><span>${t('auth.password.name')}</span><input type="text" name="displayName" autocomplete="name"></label>\n`
    : '';
  const hidden = ticket.kind === 'invite'
    ? `    <input type="hidden" name="invite" value="${escAttr(ticket.token)}">\n`
    : `    <input type="hidden" name="token" value="${escAttr(ticket.token)}">\n`;
  const mainHtml = `<main class="public-shell">
  <header class="public-header">
    <h1>${title}</h1>
    <p class="public-sub">${t('auth.password.sub', { email: ticket.email })}</p>
  </header>
  <form id="password-form" class="public-form" novalidate data-password-endpoint="/auth/password" data-msg-mismatch="${escAttr(t('auth.password.errMismatch'))}" data-msg-invalid="${escAttr(t('auth.password.errInvalid'))}" data-msg-expired="${escAttr(t('auth.password.errExpired'))}" data-msg-weak="${escAttr(t('auth.password.errTooShort', { min: password.minLength() }))}">
${hidden}${nameField}    <label><span>${t('auth.password.new')}</span><input type="password" name="password" required autocomplete="new-password" minlength="${password.minLength()}"></label>
    <label><span>${t('auth.password.repeat')}</span><input type="password" name="password2" required autocomplete="new-password"></label>
    <p class="public-sub">${t('auth.password.rule', { min: password.minLength() })}</p>
${altchaWidget()}    <div class="public-form-actions">
      <button type="submit" class="public-btn public-btn--primary">${t('auth.password.submit')}</button>
    </div>
    <p class="public-msg public-msg--err" data-login-err hidden></p>
  </form>
</main>`;
  res.set('Cache-Control', 'no-store');
  res.send(renderPublicShell({
    lang, title, mainHtml,
    scripts: `${altcha.isEnabled() ? '<script type="module" src="/vendor/altcha-3.0.11.min.js"></script>\n' : ''}<script src="/js/password-form.js"></script>\n`,
  }));
}

router.get('/auth/password', (req, res) => {
  const lang = bodyLang(req);
  const ticket = resolveTicket({
    inviteToken: typeof req.query.invite === 'string' ? req.query.invite : null,
    token: typeof req.query.token === 'string' ? req.query.token : null,
  });
  if (!ticket) {
    return renderNotice(res, {
      lang,
      status: 400,
      title: tServer('auth.password.invalidTitle', lang),
      body: tServer('auth.password.invalidBody', lang),
      ctaHref: '/login',
      ctaLabel: tServer('auth.logout.cta', lang),
    });
  }
  renderPasswordPage(req, res, { ticket, lang });
});

router.post('/auth/password', express.json({ limit: '8kb' }), asyncRoute('POST /auth/password', async (req, res) => {
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || null;
  // Derselbe Bucket wie die Anmeldung: wer Tokens durchprobiert, deckelt sich
  // damit auch den Login-Pfad.
  const state = rateLimit.getState(ip);
  if (state.blocked) {
    res.set('Retry-After', String(state.retryAfterSec || 900));
    return res.status(429).json({ error_code: 'RATE_LIMITED', retryAfter: state.retryAfterSec });
  }
  const captcha = await altcha.verify((req.body || {}).altcha);
  if (!captcha.ok) return res.status(400).json({ error_code: 'CAPTCHA_FAILED' });

  const { invite, token, password: pw, displayName } = req.body || {};
  const ticket = resolveTicket({ inviteToken: invite || null, token: token || null });
  if (!ticket) {
    rateLimit.recordFailure(ip);
    return res.status(400).json({ error_code: 'TOKEN_INVALID' });
  }
  const policyError = password.validatePassword(pw);
  if (policyError) {
    return res.status(400).json({ error_code: 'PASSWORD_WEAK', detail: policyError, min: password.minLength() });
  }

  const hash = await password.hashPassword(pw);
  const email = ticket.email;
  let user = appUsers.getUser(email);

  if (ticket.kind === 'invite') {
    // Konto entsteht erst hier — die Einladung allein hat noch keins angelegt.
    if (!user) {
      user = appUsers.createUser({
        email,
        displayName: String(displayName || '').trim().slice(0, 120) || email,
        globalRole: ticket.invite.global_role,
        status: 'active',
        invitedBy: ticket.invite.invited_by,
      });
      recordUsageEvent({ userEmail: email, event: 'account.created', meta: { method: 'local', via: 'invite' } });
      if (user?.ai_profile_id) {
        appUsers.recordAuditEvent(email, 'ai-provider-changed', {
          ip, userAgent,
          meta: { from: null, to: user.ai_profile_id, by: ticket.invite.invited_by, reason: 'invite-inherited' },
        });
      }
    }
    appUsers.acceptInvite(ticket.invite.id);
    logger.info(`Invite angenommen (lokal): ${email} von ${ticket.invite.invited_by}`, { user: email });
  } else if (!creds.consumeToken(ticket.row.id)) {
    // Ein paralleler Request war schneller — das Token ist verbraucht.
    return res.status(400).json({ error_code: 'TOKEN_INVALID' });
  }

  if (!user) return res.status(400).json({ error_code: 'TOKEN_INVALID' });
  if (user.status === 'suspended' || user.status === 'deleted') {
    return res.status(403).json({ error_code: 'USER_NOT_ACTIVE', reason: user.status });
  }

  creds.setPassword(email, hash, { mustChange: 0, updatedBy: null });
  // Alle uebrigen offenen Links entwerten: ein zweiter, aelterer Reset-Link
  // darf das gerade gesetzte Passwort nicht wieder aushebeln.
  creds.revokeOpenTokens(email);
  appUsers.recordAuditEvent(email, 'password-set', {
    ip, userAgent, meta: { via: ticket.kind === 'invite' ? 'invite' : ticket.row.purpose },
  });
  appUsers.touchLogin(email);
  appUsers.recordAuditEvent(email, 'login', { ip, userAgent, meta: { method: 'local' } });
  recordUsageEvent({ userEmail: email, event: 'auth.login', meta: { method: 'local' } });
  rateLimit.recordSuccess(ip);
  establishSession(req, res, { email, name: user.display_name || email, role: user.global_role });
  logger.info('Passwort gesetzt + Login (lokal).', { user: email });
  req.session.save(err => {
    if (err) return res.status(500).json({ error_code: 'SESSION_SAVE_FAILED' });
    res.json({ ok: true, redirect: '/' });
  });
}));

// ── Passwort vergessen ─────────────────────────────────────────────────────

router.get('/auth/forgot', (req, res) => {
  const lang = bodyLang(req);
  const t = (k, p) => (p ? tServerParams(k, _escParams(p), lang) : tServer(k, lang));
  if (!selfResetEnabled()) {
    return renderNotice(res, {
      lang,
      status: 404,
      title: t('auth.forgot.disabledTitle'),
      body: t('auth.forgot.disabledBody'),
      ctaHref: '/login',
      ctaLabel: t('auth.logout.cta'),
    });
  }
  const title = t('auth.forgot.title');
  res.set('Cache-Control', 'no-store');
  res.send(renderPublicShell({
    lang,
    title,
    mainHtml: `<main class="public-shell">
  <header class="public-header">
    <h1>${title}</h1>
    <p class="public-sub">${t('auth.forgot.sub')}</p>
  </header>
  <form id="forgot-form" class="public-form" novalidate data-password-endpoint="/auth/forgot" data-msg-sent="${escAttr(t('auth.forgot.sent'))}" data-msg-invalid="${escAttr(t('auth.password.errInvalid'))}">
    <label><span>${t('auth.login.email')}</span><input type="email" name="email" required autocomplete="username"></label>
${altchaWidget()}    <div class="public-form-actions">
      <button type="submit" class="public-btn public-btn--primary">${t('auth.forgot.submit')}</button>
    </div>
    <p class="public-msg" data-login-msg hidden></p>
    <p class="public-msg public-msg--err" data-login-err hidden></p>
  </form>
  <section class="public-actions">
    <a class="public-btn" href="/login">${t('auth.forgot.back')}</a>
  </section>
</main>`,
    scripts: `${altcha.isEnabled() ? '<script type="module" src="/vendor/altcha-3.0.11.min.js"></script>\n' : ''}<script src="/js/password-form.js"></script>\n`,
  }));
});

router.post('/auth/forgot', express.json({ limit: '8kb' }), asyncRoute('POST /auth/forgot', async (req, res) => {
  if (!selfResetEnabled()) return res.status(404).json({ error_code: 'SELF_RESET_DISABLED' });
  const ip = clientIp(req);
  const state = rateLimit.getState(ip);
  if (state.blocked) {
    res.set('Retry-After', String(state.retryAfterSec || 900));
    return res.status(429).json({ error_code: 'RATE_LIMITED', retryAfter: state.retryAfterSec });
  }
  const captcha = await altcha.verify((req.body || {}).altcha);
  if (!captcha.ok) return res.status(400).json({ error_code: 'CAPTCHA_FAILED' });

  const email = String((req.body || {}).email || '').trim().toLowerCase();
  // Anti-User-Enumeration: die Antwort ist IMMER dieselbe — auch bei unbekannter,
  // gesperrter oder nie lokal angemeldeter Adresse. Ein Fehlversuch zaehlt
  // trotzdem gegen den Rate-Limit, sonst wird der Endpunkt zum Adress-Orakel
  // ueber die Antwortzeit.
  rateLimit.recordFailure(ip);
  const user = email ? appUsers.getUser(email) : null;
  if (user && user.status === 'active' && creds.hasPassword(email)) {
    try {
      const { mail } = await issuePasswordLink(email, {
        purpose: 'reset', locale: user.language || 'de',
      });
      appUsers.recordAuditEvent(email, 'password-reset-requested', {
        ip, userAgent: req.headers['user-agent'] || null, meta: { mailSent: !!mail.sent },
      });
      if (!mail.sent) logger.warn(`Passwort-Reset: Mailversand fehlgeschlagen (${mail.reason || '—'}).`, { user: email });
    } catch (e) {
      logger.warn(`Passwort-Reset fehlgeschlagen: ${e.message}`, { user: email });
    }
  } else if (email) {
    logger.info(`Passwort-Reset fuer unbekannte/inaktive Adresse angefragt (ip=${ip || '-'}).`);
  }
  res.status(202).json({ ok: true });
}));

// ── Login-Seite ────────────────────────────────────────────────────────────

module.exports = {
  id: ID,
  router,
  isConfigured,
  configKeys: ['auth.local.min_password_length', 'auth.local.token_ttl_hours', 'auth.local.allow_self_reset'],

  // Ein Einladungslink fuehrt direkt auf die Setz-Seite: es gibt keinen
  // fremden Anbieter, bei dem sich der Eingeladene erst ausweisen koennte.
  inviteRedirect: (token) => `/auth/password?invite=${encodeURIComponent(token)}`,

  renderLoginBlock: ({ t, returnTo }) => pwForm({
    t,
    id: 'local-form',
    endpoint: '/auth/local-login',
    returnTo,
    heading: t('auth.login.localTitle'),
    emailLabel: t('auth.login.localEmail'),
    submitLabel: t('auth.login.localSubmit'),
    extraHtml: selfResetEnabled()
      ? `    <p class="public-sub"><a href="/auth/forgot">${t('auth.login.forgot')}</a></p>\n`
      : '',
  }),

  loginScripts: () => '', // credential-login.js liefert die Shell fuer alle Passwort-Formen

  // Vom Admin-Pfad mitbenutzt (routes/admin-users.js).
  issuePasswordLink,
};
