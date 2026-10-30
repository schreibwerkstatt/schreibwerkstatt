'use strict';
// Gemeinsamer Kern aller Passwort-Anmeldungen: ENV-Admin, Demo-Zugang und die
// lokale Anmeldung. Nur die Pruefung der Zugangsdaten unterscheidet sich; die
// sicherheitsrelevante Sequenz
//
//   Rate-Limit → ALTCHA → Pruefung → Audit → Sitzung
//
// ist damit per Konstruktion in allen drei Pfaden identisch und kann nicht
// auseinanderdriften.
//
// Der Rate-Limit-Bucket ist bewusst GETEILT (lib/admin-login-ratelimit, Key =
// IP): Brute-Force gegen den einen Pfad deckelt auch die anderen.

const crypto = require('crypto');
const logger = require('../../logger');
const appUsers = require('../../db/app-users');
const rateLimit = require('../../lib/admin-login-ratelimit');
const altcha = require('../../lib/altcha');
const { setSessionFingerprintCookie } = require('../../lib/session-fingerprint');
const { asyncRoute } = require('./async-route');

function clientIp(req) {
  // Nur req.ip (aufgeloest via `trust proxy`-Hop). Client-supplied X-Forwarded-For
  // ist spoofbar und darf fuer Rate-Limit-/Anti-Abuse-Keys nicht verwendet werden.
  return req.ip || null;
}

/**
 * Konstant-zeit-Vergleich gleichgrosser Buffer. Beide Seiten auf SHA-256
 * normalisieren, damit die Buffer-Laenge identisch ist und timingSafeEqual
 * nicht ueber unterschiedliche Laengen die Antwort verraet.
 */
function secretsMatch(expected, given) {
  if (!expected || !given) return false;
  const a = crypto.createHash('sha256').update(String(expected)).digest();
  const b = crypto.createHash('sha256').update(String(given)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Sitzung eroeffnen und den Fingerprint ans Cookie haengen.
 *
 * Der Fingerprint muss raus, BEVOR die Antwort den Server verlaesst: die
 * folgende SPA-Navigation auf `/` kommt cache-only aus dem SHELL_CACHE und
 * erreicht den Server nicht mehr (lib/session-fingerprint.js).
 */
function establishSession(req, res, { email, name, picture = null, role }) {
  req.session.user = { email, name, picture, role };
  req.session.loginAt = Date.now();
  setSessionFingerprintCookie(req, res);
}

/**
 * Authenticator fuer die beiden ENV-Pfade (Admin-Notfallzugang, Demo-Zugang).
 * Wahrheit lebt in ENV; `ensureUser()` stellt die app_users-Row sicher und
 * entscheidet als einzige Stelle ueber die Rolle der Sitzung.
 */
function envAuthenticator({ envEmailKey, envPasswordKey, ensureUser }) {
  return async ({ email, password }) => {
    const expectedEmail = (process.env[envEmailKey] || '').toLowerCase().trim();
    const emailMatch = email && expectedEmail && email === expectedEmail;
    const passwordMatch = secretsMatch(process.env[envPasswordKey], password);
    if (!emailMatch || !passwordMatch) return { ok: false };
    // Status-Gate greift erst NACH dem Credential-Check, damit die Antwort
    // nicht verraet, ob ein Konto existiert.
    const ensured = ensureUser();
    if (ensured && ensured.denied) return { ok: true, denied: ensured.denied };
    return { ok: true, role: ensured.role, name: ensured.name };
  };
}

/**
 * Express-Handler fuer einen Passwort-Login-Endpunkt.
 *
 * `authenticate({ email, password, req })` liefert:
 *   { ok: false }                       → 401 INVALID_CREDENTIALS
 *   { ok: true, denied: 'suspended' }   → 403 USER_NOT_ACTIVE
 *   { ok: true, redirect: '/…' }        → 200 ohne Sitzung (z. B. Passwortwechsel faellig)
 *   { ok: true, role, name }            → 200 mit Sitzung
 */
function credentialLogin(cfg) {
  const { disabledCode, isEnabled, method, logLabel, authenticate, onSuccess } = cfg;
  return asyncRoute(`credential-login[${method}]`, async (req, res) => {
    if (!isEnabled()) return res.status(404).json({ error_code: disabledCode });
    const ip = clientIp(req);
    const state = rateLimit.getState(ip);
    if (state.blocked) {
      res.set('Retry-After', String(state.retryAfterSec || 900));
      return res.status(429).json({ error_code: 'RATE_LIMITED', retryAfter: state.retryAfterSec });
    }
    const { email, password, altcha: altchaSolution } = req.body || {};
    // ALTCHA vor dem Credential-Check: ohne gueltige PoW-Loesung kein Versuch.
    // Kein recordFailure hier — ein fehlendes/ungueltiges Token ist keine
    // Credential-Brute-Force, und der Solver-CPU-Aufwand deckelt Bots bereits.
    const captcha = await altcha.verify(altchaSolution);
    if (!captcha.ok) return res.status(400).json({ error_code: 'CAPTCHA_FAILED' });

    const givenEmail = (email || '').toLowerCase().trim();
    const userAgent = req.headers['user-agent'] || null;
    const result = await authenticate({ email: givenEmail, password, req });

    if (!result || !result.ok) {
      const after = rateLimit.recordFailure(ip);
      appUsers.recordAuditEvent(givenEmail || 'unknown', 'login-denied', {
        ip, userAgent, meta: { method, failCount: after.failCount },
      });
      logger.warn(`${logLabel} fehlgeschlagen.`, { user: givenEmail });
      return res.status(401).json({ error_code: 'INVALID_CREDENTIALS' });
    }

    rateLimit.recordSuccess(ip);

    if (result.denied) {
      appUsers.recordAuditEvent(givenEmail, 'login-denied', { ip, userAgent, meta: { method, reason: result.denied } });
      logger.warn(`${logLabel} verweigert (Status ${result.denied}).`, { user: givenEmail });
      return res.status(403).json({ error_code: 'USER_NOT_ACTIVE', reason: result.denied });
    }

    // Zugangsdaten stimmen, aber es entsteht (noch) keine Sitzung: der Aufrufer
    // muss zuerst woanders hin — beim Initialpasswort auf die Setz-Seite.
    // Bewusst KEINE halb angemeldete Sitzung, die ein Guard danach wieder
    // einfangen muesste.
    if (result.redirect) {
      appUsers.recordAuditEvent(givenEmail, 'login-denied', {
        ip, userAgent, meta: { method, reason: result.reason || 'password-change-required' },
      });
      logger.info(`${logLabel}: Passwortwechsel faellig.`, { user: givenEmail });
      return res.json({ ok: true, redirect: result.redirect });
    }

    appUsers.touchLogin(givenEmail);
    appUsers.recordAuditEvent(givenEmail, 'login', { ip, userAgent, meta: { method } });
    establishSession(req, res, { email: givenEmail, name: result.name, role: result.role });
    logger.info(`${logLabel}.`, { user: givenEmail });

    // Post-Login-Hook (Demo-Seed). Non-fatal: ein Fehler darf den bereits
    // erfolgreichen Login nicht in einen 500 verwandeln.
    if (onSuccess) {
      try { await onSuccess(givenEmail); }
      catch (e) { logger.warn(`${logLabel}: Post-Login-Hook fehlgeschlagen: ${e.message}`, { user: givenEmail }); }
    }
    req.session.save(err => {
      if (err) return res.status(500).json({ error_code: 'SESSION_SAVE_FAILED' });
      res.json({ ok: true });
    });
  });
}

module.exports = { credentialLogin, envAuthenticator, establishSession, secretsMatch, clientIp };
