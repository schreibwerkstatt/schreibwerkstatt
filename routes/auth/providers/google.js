'use strict';
// Anmelde-Verfahren „Google" (OpenID Connect).
//
// Vertrag eines Verfahrens: siehe ./index.js. Dieses Modul haelt alles, was nur
// Google betrifft — den OIDC-Client, die beiden Endpunkte und den Block auf der
// Login-Seite. Wer ein weiteres IdP-Verfahren ergaenzt, kopiert die Form dieser
// Datei und traegt sie in die Registry ein; weder Login-Seite noch Auth-Guard
// muessen dafuer angefasst werden.

const express = require('express');
const { Issuer, generators } = require('openid-client');
const logger = require('../../../logger');
const appUsers = require('../../../db/app-users');
const { recordUsageEvent } = require('../../../lib/usage-events');
const appSettings = require('../../../lib/app-settings');
const { publicUrl } = require('../../../lib/public-url');
const { clientIp, establishSession } = require('../credential-login');
const { bodyLang, safeReturnTo, renderDenied } = require('../render');

const ID = 'google';

// OIDC-Client wird einmalig initialisiert und gecacht. Bei Aenderung relevanter
// app_settings-Keys verworfen, damit die neue Konfiguration beim naechsten
// Login greift — ohne Server-Restart.
let oidcClient = null;
appSettings.on('changed', ({ key }) => {
  if (key === 'app.public_url' || key === 'auth.google.client_id' || key === 'auth.google.client_secret') {
    oidcClient = null;
  }
});

async function getClient() {
  if (oidcClient) return oidcClient;
  const googleIssuer = await Issuer.discover('https://accounts.google.com');
  const appUrl = publicUrl();
  if (!appUrl) throw new Error('app.public_url ist nicht gesetzt — Admin muss die öffentliche URL in den App-Einstellungen hinterlegen.');
  oidcClient = new googleIssuer.Client({
    client_id: appSettings.get('auth.google.client_id'),
    client_secret: appSettings.get('auth.google.client_secret'),
    redirect_uris: [`${appUrl}/auth/callback`],
    response_types: ['code'],
  });
  return oidcClient;
}

function isConfigured() {
  return !!(appSettings.get('auth.google.client_id') && appSettings.get('auth.google.client_secret'));
}

// Maximal parallele offene Login-Flows pro Session (aeltere werden verworfen).
const MAX_PENDING_FLOWS = 5;

const router = express.Router();

// GET /auth/login → redirect zu Google (oder direkt zu / im LOCAL_DEV_MODE).
router.get('/auth/login', async (req, res) => {
  if (!isConfigured()) {
    return res.status(500).send(
      'Google OAuth nicht konfiguriert. Admin muss auth.google.client_id und auth.google.client_secret in den App-Einstellungen setzen.'
    );
  }
  try {
    const client = await getClient();
    const state = generators.state();
    const nonce = generators.nonce();
    const returnTo = safeReturnTo(req.query.returnTo);
    // Mehrere parallele Login-Flows (z.B. mehrere Tabs) nebeneinander erlauben:
    // State → { nonce, returnTo } ablegen, im Callback gezielt nachschlagen.
    const pending = Array.isArray(req.session.oidcPending) ? req.session.oidcPending : [];
    pending.push({ state, nonce, returnTo, ts: Date.now() });
    while (pending.length > MAX_PENDING_FLOWS) pending.shift();
    req.session.oidcPending = pending;
    const url = client.authorizationUrl({ scope: 'openid email profile', state, nonce });
    req.session.save((saveErr) => {
      if (saveErr) {
        logger.error('Session save error: ' + saveErr.message);
        return res.status(500).send('Session-Fehler: ' + saveErr.message);
      }
      res.redirect(url);
    });
  } catch (err) {
    logger.error('Auth login error: ' + err.message);
    res.status(500).send('Anmeldung fehlgeschlagen: ' + err.message);
  }
});

// GET /auth/callback → Token validieren, Session anlegen.
router.get('/auth/callback', async (req, res) => {
  try {
    const client = await getClient();
    const appUrl = publicUrl();
    const params = client.callbackParams(req);
    // Passenden pending-Flow suchen (Mehrtab-Support).
    const pending = Array.isArray(req.session.oidcPending) ? req.session.oidcPending : [];
    const flowIdx = pending.findIndex(f => f.state === params.state);
    const flow = flowIdx >= 0 ? pending[flowIdx] : null;
    if (!flow) {
      logger.warn(`Auth callback: kein passender Login-Flow für state=${params.state}`);
      return res.status(400).send(
        'Anmeldung abgelaufen oder ungültig. <a href="/login">Erneut anmelden</a>'
      );
    }
    const tokenSet = await client.callback(
      `${appUrl}/auth/callback`,
      params,
      { state: flow.state, nonce: flow.nonce }
    );
    const claims = tokenSet.claims();
    const email = (claims.email || '').toLowerCase();
    const ip = clientIp(req);
    const userAgent = req.headers['user-agent'] || null;
    const lang = bodyLang(req);

    // app_users-Lookup + Status-Gate + Invite-Accept-Flow.
    let user = appUsers.getUser(email);
    if (user) {
      if (user.status === 'suspended' || user.status === 'deleted') {
        appUsers.recordAuditEvent(email, 'login-denied', { ip, userAgent, meta: { method: 'oidc', reason: user.status } });
        return renderDenied(res, lang, user.status);
      }
    } else {
      // Kein Eintrag in app_users: pruefen, ob ein gueltiger Invite-Token im
      // returnTo verlinkt ist, oder ALLOW_OPEN_SIGNUP greift.
      const inviteToken = (() => {
        try { return new URL(flow.returnTo || '', 'http://x').searchParams.get('invite'); }
        catch { return null; }
      })();
      let acceptedInvite = null;
      if (inviteToken) {
        const inv = appUsers.findInviteByToken(inviteToken);
        if (inv && inv.email === email && appUsers.inviteStatus(inv) === 'active') {
          acceptedInvite = inv;
        }
      }
      if (acceptedInvite) {
        user = appUsers.createUser({
          email,
          displayName: claims.name || email,
          globalRole: acceptedInvite.global_role,
          status: 'active',
          invitedBy: acceptedInvite.invited_by,
        });
        appUsers.acceptInvite(acceptedInvite.id);
        recordUsageEvent({ userEmail: email, event: 'account.created', meta: { method: 'oidc', via: 'invite' } });
        // Das KI-Profil erbt createUser vom Einladenden (db/app-users.js). Die
        // Herkunft gehoert in die Audit-Spur, sonst steht im Admin-Drawer ein
        // Profil ohne jede Zuweisung.
        if (user?.ai_profile_id) {
          appUsers.recordAuditEvent(email, 'ai-provider-changed', {
            ip, userAgent,
            meta: { from: null, to: user.ai_profile_id, by: acceptedInvite.invited_by, reason: 'invite-inherited' },
          });
        }
        logger.info(
          `Invite angenommen: ${email} von ${acceptedInvite.invited_by}`
          + ` (ki-profil=${user?.ai_profile_id ?? 'global'})`,
          { user: email },
        );
      } else if (appSettings.get('auth.allow_open_signup') === true) {
        user = appUsers.createUser({
          email,
          displayName: claims.name || email,
          globalRole: 'user',
          status: 'active',
        });
        recordUsageEvent({ userEmail: email, event: 'account.created', meta: { method: 'oidc', via: 'open-signup' } });
      } else {
        appUsers.recordAuditEvent(email, 'login-denied', { ip, userAgent, meta: { method: 'oidc', reason: 'not-invited' } });
        logger.warn('Login verweigert (kein Invite, ALLOW_OPEN_SIGNUP=false).', { user: email });
        return renderDenied(res, lang, 'notInvited');
      }
    }

    const returnTo = safeReturnTo(flow.returnTo);
    // Verbrauchten Flow entfernen; uebrige parallele Flows nicht antasten.
    if (flowIdx >= 0) {
      pending.splice(flowIdx, 1);
      req.session.oidcPending = pending;
    }
    delete req.session.returnTo;
    appUsers.touchLogin(email, claims.name || null);
    appUsers.recordAuditEvent(email, 'login', { ip, userAgent, meta: { method: 'oidc' } });
    recordUsageEvent({ userEmail: email, event: 'auth.login', meta: { method: 'oidc' } });
    establishSession(req, res, {
      email,
      name: claims.name || user.display_name || email,
      picture: claims.picture || null,
      role: user.global_role,
    });
    logger.info('Login', { user: email });
    res.redirect(returnTo);
  } catch (err) {
    logger.error('Auth callback error: ' + err.message);
    res.status(500).send('Anmeldung fehlgeschlagen: ' + err.message);
  }
});

module.exports = {
  id: ID,
  router,
  isConfigured,
  // Keys, die der Admin fuer dieses Verfahren gesetzt haben muss. Das
  // Settings-UI zeigt sie, und der Konfigurations-Check liest sie hier —
  // nicht in einer zweiten Liste im Frontend.
  configKeys: ['auth.google.client_id', 'auth.google.client_secret', 'app.public_url'],

  // Wohin fuehrt ein angeklickter Einladungslink? Bei OIDC durch den normalen
  // Login: der Token reist im returnTo mit und wird im Callback eingeloest.
  inviteRedirect: (token) => `/login?returnTo=${encodeURIComponent(`/?invite=${token}`)}`,

  renderLoginBlock: ({ t, returnTo }) => `  <section class="public-actions">
    <a class="public-btn public-btn--primary" href="/auth/login?returnTo=${encodeURIComponent(returnTo)}">${t('auth.login.google')}</a>
  </section>
`,
  loginScripts: () => '',
};
