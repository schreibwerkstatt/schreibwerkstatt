'use strict';
// Session-/Device-Token-Guard vor allen geschuetzten Routen.
//
// Antwort ohne Anmeldung: nur eine Browser-Navigation bekommt den Redirect auf
// /login, jeder andere Request `401 { error_code: 'NOT_LOGGED_IN' }`. Die
// Entscheidung haengt am Request, nicht an einer Pfadliste: eine Liste
// „API-Praefixe" deckt nie alle gemounteten Router ab, und ein fetch(), der
// statt des 401 ein 302 auf Login-HTML bekommt, laeuft am zentralen
// session-expired-Handling vorbei (public/js/app.js) und scheitert als
// JSON-Parse-Fehler. Clients ohne Sec-Fetch-Header (native Clients, Skripte)
// senden kein `Accept: text/html` und bekommen darum ebenfalls den 401.

const logger = require('../logger');
const { setContext } = require('./log-context');
const { tryDeviceAuth, extractBearer } = require('./device-auth');
const deviceTokens = require('../db/device-tokens');
const appUsers = require('../db/app-users');

/** true = Browser-Navigation, die auf die Login-Seite umgeleitet werden soll. */
function wantsLoginRedirect(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const mode = req.headers['sec-fetch-mode'];
  if (mode) return mode === 'navigate';
  // Ohne Fetch-Metadata (aeltere Browser): nur wer HTML vor JSON bevorzugt.
  const accept = String(req.headers.accept || '');
  if (!/text\/html/i.test(accept)) return false;
  return req.accepts(['html', 'json']) === 'html';
}

function rejectUnauthenticated(req, res) {
  if (wantsLoginRedirect(req)) {
    return res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
  }
  return res.status(401).json({ error_code: 'NOT_LOGGED_IN' });
}

// LOCAL_DEV_MODE: Auto-Dev-Session als Admin (idempotenter Upsert).
function _ensureDevSession(req) {
  req.session.user = { email: 'dev@local', name: 'Dev (lokal)', role: 'admin' };
  try {
    const existing = appUsers.getUser('dev@local');
    if (!existing) {
      appUsers.createUser({ email: 'dev@local', displayName: 'Dev (lokal)', globalRole: 'admin', status: 'active', markChangelogSeen: false });
    } else if (existing.global_role !== 'admin' || existing.status !== 'active') {
      if (existing.global_role !== 'admin') appUsers.setGlobalRole('dev@local', 'admin');
      if (existing.status !== 'active') appUsers.setStatus('dev@local', 'active');
    }
    appUsers.touchLogin('dev@local', 'Dev (lokal)');
  } catch (e) { logger.warn(`dev-mode admin upsert: ${e.message}`); }
}

// Eine Sitzung gilt nur, solange ihr Konto existiert und nicht gesperrt ist.
// Ein PK-Lookup pro Request (app_users.email, prepared Statement) — billiger
// als jeder Cache, der nach einer Loeschung erst invalidiert werden muesste.
// Token-Sitzungen (`via` gesetzt) stammen aus tryDeviceAuth/requireBearer und
// sind dort schon gegen dasselbe Gate geprueft. Der ENV-Admin (ADMIN_EMAIL) ist
// der Notfall-Zugang und loggt sich ohne Status-Gate ein (routes/auth/shell.js)
// — der Guard darf ihn nicht nachtraeglich aussperren.
function _isEnvAdmin(email) {
  const env = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  return !!env && String(email).trim().toLowerCase() === env;
}

function sessionUserIsValid(user) {
  if (!user?.email) return false;
  if (user.via) return true;
  if (_isEnvAdmin(user.email)) return true;
  const row = appUsers.getUser(user.email);
  return !!row && row.status !== 'deleted' && row.status !== 'suspended';
}

// Nur den User aus der Sitzung nehmen, nicht `destroy()`: der Request laeuft
// weiter durch Device-/Dev-Pfad, die `req.session` noch brauchen. Die Sitzung
// wird ohne User zurueckgeschrieben und ist damit abgemeldet.
function _dropSession(req) {
  delete req.session.user;
}

function makeAuthGuard({ localDevMode = false } = {}) {
  return function authGuard(req, res, next) {
    // Device-Token (native Clients, z.B. Mac-Focus-Writer): Bearer swd_… loest auf
    // den echten User + dessen echte Rolle auf und respektiert das Status-Gate.
    // req.session.user wird gesetzt, sodass downstream (ACL, Logging, Activity)
    // den Request wie eine normale Session behandelt.
    //
    // Traegt der Request ein swd_-Bearer-Token, hat die Device-Auth IMMER Vorrang —
    // ein mitgeschicktes Session-Cookie zaehlt nicht. Token-Requests laufen darum
    // auf einer leeren In-Memory-Session (lib/token-session.js); wuerde ein Cookie
    // die Device-Auth kurzschliessen, fror die touchTokenUsage-Telemetrie ein und
    // widerrufene Tokens blieben gueltig. Bei ungueltigem/widerrufenem Token geht
    // es deshalb direkt in 401/Redirect, nie zurueck auf eine Cookie-Session.
    const bearer = extractBearer(req);
    const isDeviceBearer = !!bearer && bearer.startsWith(deviceTokens.TOKEN_PREFIX);
    if (req.session?.user && !isDeviceBearer) {
      if (sessionUserIsValid(req.session.user)) return next();
      // Konto geloescht oder gesperrt: die Sitzung ist wertlos, auch wenn ihr
      // Cookie noch bis zu sieben Tage laeuft. Gleiche Regel wie tryDeviceAuth.
      logger.info(`Sitzung ohne gueltiges Konto verworfen (${req.session.user.email || '-'})`);
      _dropSession(req);
    }
    const deviceUser = tryDeviceAuth(req);
    if (deviceUser) {
      req.session.user = deviceUser;
      // Der ALS-Log-Context wurde mit user=null eingefroren (Device-Auth laeuft
      // erst hier, nach Session-Pruefung) — User nachtragen, damit Client-Requests
      // im Log-Tag dem User zugeordnet sind.
      setContext({ user: deviceUser.email });
      return next();
    }
    if (isDeviceBearer) return rejectUnauthenticated(req, res);
    // Dev-Logout-Marker (gesetzt durch /auth/logout): Auto-Dev-Session unterbinden,
    // damit der User Logout/Login-Flow wie in Prod testen kann. /auth/login raeumt
    // den Marker.
    if (localDevMode && !/(?:^|;\s*)sw_devout=1(?:;|$)/.test(req.headers.cookie || '')) {
      _ensureDevSession(req);
      return next();
    }
    return rejectUnauthenticated(req, res);
  };
}

module.exports = { makeAuthGuard, wantsLoginRedirect, rejectUnauthenticated };
