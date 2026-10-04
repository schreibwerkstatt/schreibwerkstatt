'use strict';
// Verfahrens-unabhaengiger Teil der Anmeldung: Login-Seite, Abmeldung,
// Einladungs-Klick, Avatar-Proxy und die beiden ENV-Passwort-Pfade.
//
// Was hier steht, gilt fuer JEDES Anmeldeverfahren. Alles, was nur eines
// betrifft, liegt in ./providers/ — siehe dort den Vertrag.
//
// Die ENV-Pfade (ADMIN_EMAIL/ADMIN_PASSWORD, DEMO_EMAIL/DEMO_PASSWORD) stehen
// bewusst NEBEN der Verfahrenswahl: der ENV-Admin ist der Notfall-Zugang zur
// Instanz und muss auch dann tragen, wenn das gewaehlte Verfahren gerade nicht
// funktioniert (falsch konfigurierter IdP, IdP-Ausfall). Der Demo-Zugang
// existiert fuer Store-Reviews, denen man kein Google-Konto geben kann.

const express = require('express');
const logger = require('../../logger');
const appUsers = require('../../db/app-users');
const appSettings = require('../../lib/app-settings');
const altcha = require('../../lib/altcha');
const avatarCache = require('../../lib/avatar-cache');
const demoUser = require('../../lib/demo-user');
const { tServer } = require('../../lib/i18n-server');
const { sessionEmail } = require('../../lib/acl');
const providers = require('./providers');
const { credentialLogin, envAuthenticator, clientIp } = require('./credential-login');
const { escAttr, bodyLang, safeReturnTo, renderPublicShell, renderNotice, pwForm } = require('./render');

const router = express.Router();

// GET /invite/:token → loggt Klick (last_clicked_at, click_count) und leitet
// dorthin weiter, wo das aktive Verfahren die Einladung einloest. Damit sieht
// der Admin im Tab „Eingeladene Benutzer", ob der User die Mail geoeffnet hat —
// auch wenn er sich noch nicht angemeldet hat. Oeffentlicher Endpoint.
//
// Auch fuer abgelaufene/widerrufene/akzeptierte Tokens wird weitergeleitet —
// das Ziel wirft dann den passenden Fehler. Klick-Tracking laeuft nur fuer
// 'active'-Status, damit Wiederholungs-Klicks auf alte Mails die Statistik
// nicht verwaessern.
router.get('/invite/:token', (req, res) => {
  const token = String(req.params.token || '');
  if (token) {
    try {
      const inv = appUsers.findInviteByToken(token);
      if (inv && appUsers.inviteStatus(inv) === 'active') {
        appUsers.markInviteClicked(inv.id);
      }
    } catch (e) {
      logger.warn(`invite-click: ${e.message}`);
    }
  }
  res.redirect(providers.activeProvider().inviteRedirect(token));
});

// GET /auth/login im LOCAL_DEV_MODE: direkt zu `/`. Verfahrens-unabhaengig und
// darum hier, vor den Provider-Routern — der Dev-Guard legt die Session selbst an.
router.get('/auth/login', (req, res, next) => {
  if (process.env.LOCAL_DEV_MODE !== 'true') return next();
  // Logout-Marker raeumen, damit der Guard wieder eine Dev-Session anlegen darf.
  res.clearCookie('sw_devout', { path: '/' });
  res.redirect('/');
});

// GET /login → Landing-Page mit dem Block des aktiven Verfahrens plus den
// ENV-Pfaden, soweit konfiguriert. Der Auth-Guard redirected unauth User
// hierhin (statt direkt zum IdP), damit der Notfall-Pfad sichtbar bleibt.
router.get('/login', (req, res) => {
  if (process.env.LOCAL_DEV_MODE === 'true') return res.redirect('/');
  if (req.session?.user) {
    return res.redirect(safeReturnTo(req.query.returnTo));
  }
  // Backcompat: Mails vor Mig 144 trugen /login?invite=TOKEN ohne returnTo.
  // Auf die Klick-Tracking-Route umlenken, damit der Klick gezaehlt wird und
  // der Token beim aktiven Verfahren ankommt.
  const legacyInvite = typeof req.query.invite === 'string' ? req.query.invite : null;
  if (legacyInvite && !req.query.returnTo) {
    return res.redirect(`/invite/${encodeURIComponent(legacyInvite)}`);
  }
  const lang = bodyLang(req);
  const t = (k) => tServer(k, lang);
  const returnTo = safeReturnTo(req.query.returnTo);
  const provider = providers.activeProvider();
  const hasAdminPw = !!process.env.ADMIN_PASSWORD;
  const hasDemo = demoUser.isEnabled();

  const blocks = [];
  if (provider.isConfigured()) blocks.push(provider.renderLoginBlock({ t, returnTo, escAttr }));
  if (hasDemo) {
    // Demo-Adresse vorbefuellen: sie ist kein Geheimnis (steht in den
    // Store-Reviewer-Notes) und ein Tippfehler des Reviewers kostet einen
    // Rejection-Zyklus. Das Passwort wird nie vorbefuellt.
    blocks.push(pwForm({
      t,
      id: 'demo-form',
      endpoint: '/auth/demo-login',
      returnTo,
      heading: t('auth.login.demoTitle'),
      hint: t('auth.login.demoHint'),
      emailLabel: t('auth.login.demoEmail'),
      submitLabel: t('auth.login.demoSubmit'),
      emailValue: demoUser.demoEmail(),
    }));
  }

  // Admin-Form zuletzt: sie ist der Notfall-Pfad, nicht der Alltagsweg. Steht
  // ein regulaeres Verfahren daneben, klappt sie hinter einen leisen Link ein,
  // damit der Verfahrens-Knopf der eine prominente Einstieg bleibt; ist sie
  // der einzige Weg, steht sie offen.
  const adminHtml = hasAdminPw
    ? pwForm({
      t,
      id: 'admin-form',
      endpoint: '/auth/admin-login',
      returnTo,
      heading: t('auth.login.adminTitle'),
      emailLabel: t('auth.login.email'),
      submitLabel: t('auth.login.submit'),
    })
    : '';

  const title = t('auth.login.title');
  const appName = appSettings.get('app.name') || 'Schreibwerkstatt';
  const sep = `  <div class="public-sep">${t('auth.login.or')}</div>\n`;
  // Kein <details>: Klapp-Sektionen laufen ueber einen Knopf mit
  // aria-expanded, den credential-login.js schaltet (Pre-Auth, ohne Alpine).
  const fallbackHtml = adminHtml && blocks.length
    ? `  <div class="public-fallback">
    <button type="button" class="public-btn-link" aria-expanded="false" aria-controls="admin-fallback" data-fallback-toggle>${t('auth.login.adminToggle')}</button>
    <div id="admin-fallback" hidden>
${adminHtml}    </div>
  </div>\n`
    : '';
  if (adminHtml && !fallbackHtml) blocks.push(adminHtml);
  const bodyHtml = blocks.length
    ? blocks.join(sep) + fallbackHtml
    : `  <p class="public-sub">${t('auth.login.noAdmin')}</p>\n`;
  // Jede Passwort-Form braucht den geteilten Handler; ALTCHA nur, wenn
  // ueberhaupt eine Form auf der Seite steht.
  const hasPwForm = !!adminHtml || blocks.some(b => b.includes('data-login-endpoint'));
  const scripts = hasPwForm
    ? `${altcha.isEnabled() ? '<script type="module" src="/vendor/altcha-3.0.11.min.js"></script>\n' : ''}<script src="/js/credential-login.js"></script>\n`
    : '';
  res.set('Cache-Control', 'no-store');
  res.send(renderPublicShell({
    lang,
    title,
    mainHtml: `<main class="public-shell public-shell--narrow">
  <header class="public-header">
    <img class="public-brand" src="/schreibwerkstatt_icon.svg" alt="" width="72" height="72">
    <h1>${escAttr(appName)}</h1>
    <p class="public-sub">${t('auth.login.lead')}</p>
  </header>
${bodyHtml}  <footer class="public-footer">
    <nav class="public-footer-links">
      <a class="public-footer-link" href="/landing">${t('auth.login.toLanding')}</a>
      <a class="public-footer-link" href="/datenschutz">${t('privacy.footerLink')}</a>
    </nav>
  </footer>
</main>`,
    scripts: scripts + provider.loginScripts(),
  }));
});

// POST /auth/admin-login → ENV-getriebener Admin-Login (Notfall-Zugang).
//
// Wahrheit lebt in ENV: ADMIN_EMAIL + ADMIN_PASSWORD. Ohne ADMIN_PASSWORD-ENV
// liefert die Route 404 (Pfad komplett deaktiviert).
router.post('/auth/admin-login', express.json(), credentialLogin({
  disabledCode: 'ADMIN_LOGIN_DISABLED',
  isEnabled: () => !!(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD),
  method: 'env',
  logLabel: 'Admin-Login (ENV-Pfad)',
  authenticate: envAuthenticator({
    envEmailKey: 'ADMIN_EMAIL',
    envPasswordKey: 'ADMIN_PASSWORD',
    // Sicherstellen, dass app_users-Row existiert + global_role='admin'. Kein
    // Status-Gate: der ENV-Admin ist der Notfall-Zugang zur Instanz und darf
    // sich nicht selbst aussperren koennen.
    ensureUser: () => {
      appUsers.ensureAdminFromEnv();
      return { role: 'admin', name: 'Admin' };
    },
  }),
}));

// POST /auth/demo-login → ENV-getriebener Demo-Zugang (Rolle 'user').
//
// Gleiche Haertung wie der Admin-Pfad (geteilte Factory + geteilter
// Rate-Limit-Bucket), aber ohne Admin-Rechte. Details + Betriebsregeln:
// lib/demo-user.js.
router.post('/auth/demo-login', express.json(), credentialLogin({
  disabledCode: 'DEMO_LOGIN_DISABLED',
  isEnabled: () => demoUser.isEnabled(),
  method: 'demo',
  logLabel: 'Demo-Login',
  authenticate: envAuthenticator({
    envEmailKey: 'DEMO_EMAIL',
    envPasswordKey: 'DEMO_PASSWORD',
    ensureUser: () => demoUser.ensureDemoUser(),
  }),
  onSuccess: (email) => demoUser.seedDemoContent(email),
}));

// GET /auth/logout → Session löschen + Landing-Page anzeigen.
// Kein Auto-Redirect zu /auth/login: die IdP-Session waere meist noch aktiv und
// wuerde uns sofort silent wieder einloggen. User klickt aktiv „Erneut anmelden".
router.get('/auth/logout', (req, res) => {
  // LOCAL_DEV_MODE: Logout no-op — der Guard wuerde sofort eine neue Dev-Admin-
  // Session anlegen, dadurch waere der Logout/Login-Zyklus visuell folgenlos.
  if (process.env.LOCAL_DEV_MODE === 'true') {
    return res.redirect('/');
  }
  const email = sessionEmail(req);
  const loginAt = req.session.loginAt;
  const lang = bodyLang(req);
  if (email) {
    appUsers.recordAuditEvent(email, 'logout', { ip: clientIp(req), userAgent: req.headers['user-agent'] || null });
  }
  req.session.destroy(() => {
    if (email) {
      const durMin = loginAt ? Math.round((Date.now() - loginAt) / 60000) : null;
      logger.info(`Logout${durMin != null ? ` (Session ${durMin} min)` : ''}`, { user: email });
    }
    // Session-Cookie aus dem Browser raeumen — `destroy()` loescht nur
    // Server-State, der Browser haelt `connect.sid` sonst weiter.
    res.clearCookie('connect.sid', { path: '/', httpOnly: true, sameSite: 'lax', secure: req.secure });
    renderNotice(res, {
      lang,
      title: tServer('auth.logout.title', lang),
      body: tServer('auth.logout.body', lang),
      ctaHref: '/login',
      ctaLabel: tServer('auth.logout.cta', lang),
    });
  });
});

// GET /auth/avatar → Same-Origin-Proxy für das Profilbild des eingeloggten
// Users. Browser-Tracking-Prevention blockiert den Direktzugriff auf
// lh3.googleusercontent.com (v.a. in Firmennetzen); der Server holt das Bild
// selbst und cached es. Liefert 404 ohne Session/Bild → Frontend fällt im
// `@error`-Handler auf die Initialen-Bubble zurück.
router.get('/auth/avatar', async (req, res) => {
  const url = req.session?.user?.picture;
  if (!url || !avatarCache.isAllowedAvatarUrl(url)) {
    return res.status(404).end();
  }
  try {
    const { buffer, contentType } = await avatarCache.getAvatar(url);
    // private: nur Browser-Cache, keine Shared-Caches (Bild ist user-spezifisch).
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('Content-Type', contentType);
    res.send(buffer);
  } catch (err) {
    logger.warn('Avatar-Proxy fehlgeschlagen: ' + err.message, { user: sessionEmail(req) });
    res.status(404).end();
  }
});

module.exports = router;
