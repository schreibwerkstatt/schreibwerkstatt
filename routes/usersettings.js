'use strict';
const express = require('express');
const appUsers = require('../db/app-users');
const deviceTokens = require('../db/device-tokens');
const { TOKEN_KINDS, DEFAULT_KIND, scopesForKind } = require('../lib/device-scopes');
const { db } = require('../db/schema');
const { listBookIdsForUser } = require('../db/book-access');
const { visibleUserDirectory } = require('../db/user-directory');
const { setContext } = require('../lib/log-context');
const logger = require('../logger');
const { sessionEmail } = require('../lib/acl');

const router = express.Router();
const jsonBody = express.json();

// Audit-Log-Events (UI-Trigger ohne anderen Server-Roundtrip).
// Allowlist verhindert beliebige Logs durch den Client.
const AUDIT_EVENTS = {
  chatOpened:     'Seiten-Chat geöffnet',
  bookChatOpened: 'Buch-Chat geöffnet',
  lektoratOpened: 'Lektorat geöffnet',
};

router.post('/event', jsonBody, (req, res) => {
  const event = String(req.body?.event || '');
  const label = AUDIT_EVENTS[event];
  if (!label) return res.status(400).json({ error_code: 'INVALID_EVENT' });
  const meta = req.body?.meta && typeof req.body.meta === 'object' ? req.body.meta : null;
  const bookId = meta && Number.isFinite(Number(meta.book)) ? parseInt(meta.book, 10) : null;
  if (bookId) setContext({ book: bookId });
  const suffix = meta
    ? ' ' + Object.entries(meta)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${k}=${v}`)
        .join(' ')
    : '';
  logger.info(`${label}${suffix}`);
  res.json({ ok: true });
});

const VALID_LOCALES   = ['de', 'en'];
const VALID_THEMES    = ['auto', 'light', 'dark'];
const VALID_LANGUAGES = ['de', 'en'];
const VALID_REGIONS   = ['CH', 'DE', 'US', 'GB'];
const VALID_BUCHTYPEN = ['roman', 'kurzgeschichten', 'gesellschaft', 'krimi', 'historisch', 'fantasy_scifi', 'erotik', 'jugend', 'autobiografie', 'andere'];
const VALID_FOCUS_GRANULARITIES = ['paragraph', 'sentence', 'window-3', 'typewriter-only'];

const FIELDS = [
  { key: 'locale',            allowed: VALID_LOCALES,             label: 'locale' },
  { key: 'theme',             allowed: VALID_THEMES,              label: 'theme' },
  { key: 'default_buchtyp',   allowed: VALID_BUCHTYPEN,           label: 'default_buchtyp' },
  { key: 'default_language',  allowed: VALID_LANGUAGES,           label: 'default_language' },
  { key: 'default_region',    allowed: VALID_REGIONS,             label: 'default_region' },
  { key: 'focus_granularity', allowed: VALID_FOCUS_GRANULARITIES, label: 'focus_granularity' },
];

// app_users.language ist die Spalte; nach aussen heisst sie `locale` (API-Vertrag).
function toResponse(u) {
  if (!u) return null;
  return {
    email:             u.email,
    created_at:        u.created_at,
    last_login_at:     u.last_login_at,
    last_seen_at:      u.last_seen_at,
    locale:            u.language,
    theme:             u.theme,
    default_buchtyp:   u.default_buchtyp,
    default_language:  u.default_language,
    default_region:    u.default_region,
    focus_granularity: u.focus_granularity,
    daily_goal_minutes: u.daily_goal_minutes ?? null,
    role:              u.global_role || 'user',
    status:            u.status || 'active',
    can_invite_users:  u.can_invite_users ? 1 : 0,
    display_name:      u.display_name || null,
    model_override:    u.model_override || null,
  };
}

/** Aktuelles User-Profil samt Einstellungen + app_users-Identity. */
router.get('/settings', (req, res) => {
  const email = sessionEmail(req);
  const user = appUsers.getUser(email);
  if (!user) return res.status(404).json({ error_code: 'USER_PROFILE_NOT_FOUND' });
  res.json(toResponse(user));
});

// „Meine Statistik": GET /profile-stats + /profile-stats-history.
require('./usersettings/profile-stats').register(router);

/**
 * Email → Display-Name-Map fuer Revision-Listen, Tree-Toasts, Konflikt-Hinweise,
 * Fassungen und Präsenz-Initialen. Der Sichtkreis (eigener Account + Co-Mitglieder
 * der eigenen Bücher) ist in `db/user-directory.js` festgeschrieben.
 */
router.get('/users-light', (req, res) => {
  res.json({ users: visibleUserDirectory(sessionEmail(req)) });
});

// API-Key (extern) → app_users-Spaltenname (intern). `locale` mappt auf `language`.
const FIELD_TO_COLUMN = {
  locale:            'language',
  theme:             'theme',
  default_buchtyp:   'default_buchtyp',
  default_language:  'default_language',
  default_region:    'default_region',
  focus_granularity: 'focus_granularity',
};

/** Partielles Update. Nicht übergebene Felder bleiben unverändert;
 *  leerer String oder null setzt das Feld zurück. */
router.patch('/settings', jsonBody, (req, res) => {
  const email = sessionEmail(req);
  const existing = appUsers.getUser(email);
  if (!existing) return res.status(404).json({ error_code: 'USER_PROFILE_NOT_FOUND' });

  const body = req.body || {};

  for (const { key, allowed, label } of FIELDS) {
    if (body[key] === undefined || body[key] === null || body[key] === '') continue;
    if (!allowed.includes(body[key])) {
      return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: label, allowed: allowed.join(', ') } });
    }
  }

  const merged = {};
  for (const { key } of FIELDS) {
    const col = FIELD_TO_COLUMN[key];
    if (body[key] === undefined)                     merged[col] = existing[col];
    else if (body[key] === '' || body[key] === null) merged[col] = null;
    else                                             merged[col] = body[key];
  }

  // Numerisches Feld (kein Enum): persoenliches Tagesziel in Minuten. 0..1440;
  // NULL/0/'' = kein Ziel. Separat behandelt, da der FIELDS-Loop Enum-validiert.
  const dg = body.daily_goal_minutes;
  if (dg === undefined) {
    merged.daily_goal_minutes = existing.daily_goal_minutes ?? null;
  } else if (dg === '' || dg === null) {
    merged.daily_goal_minutes = null;
  } else {
    const n = Math.round(Number(dg));
    if (!Number.isFinite(n) || n < 0 || n > 1440) {
      return res.status(400).json({ error_code: 'INVALID_VALUE', params: { field: 'daily_goal_minutes', allowed: '0–1440' } });
    }
    merged.daily_goal_minutes = n > 0 ? n : null;
  }

  appUsers.updateUserSettings(email, merged);
  res.json({ ok: true, ...toResponse(appUsers.getUser(email)) });
});

// ── Onboarding („Erste Schritte") ────────────────────────────────────────────
// Persistierter Teil (welcomeDismissed/completed) in app_users.onboarding_state;
// die Checklisten-Schritte werden aus echtem State abgeleitet (self-healing).

function parseOnboardingState(user) {
  let s = {};
  try { s = user?.onboarding_state ? JSON.parse(user.onboarding_state) : {}; }
  catch { s = {}; }
  return { welcomeDismissed: !!s.welcomeDismissed, completed: !!s.completed };
}

// Abgeleiteter Fortschritt: Buch angelegt → Text geschrieben → KI-Analyse
// gelaufen → geteilt. Alle Quellen sind Aggregat-/ACL-/Nicht-Content-Tabellen
// (book_access, page_stats, figures, locations, share_links) — kein direkter
// Zugriff auf pages/chapters/books (Content-Store-Regel).
function onboardingSteps(email) {
  const owned = listBookIdsForUser(email).filter(r => r.role === 'owner').map(r => r.book_id);
  const steps = { book: owned.length > 0, page: false, analysis: false, share: false };
  if (owned.length) {
    const ph = owned.map(() => '?').join(',');
    const pg = db.prepare(`SELECT COUNT(*) AS c FROM page_stats WHERE book_id IN (${ph}) AND chars > 0`).get(...owned);
    steps.page = (pg?.c || 0) > 0;
    const fig = db.prepare(`SELECT COUNT(*) AS c FROM figures WHERE book_id IN (${ph})`).get(...owned);
    const loc = db.prepare(`SELECT COUNT(*) AS c FROM locations WHERE book_id IN (${ph})`).get(...owned);
    steps.analysis = ((fig?.c || 0) + (loc?.c || 0)) > 0;
  }
  const sh = db.prepare('SELECT COUNT(*) AS c FROM share_links WHERE owner_email = ? AND revoked_at IS NULL').get(email);
  steps.share = (sh?.c || 0) > 0;
  return steps;
}

/** Onboarding-State + abgeleiteter Checklisten-Fortschritt des Users. */
router.get('/onboarding', (req, res) => {
  const email = sessionEmail(req);
  const user = appUsers.getUser(email);
  if (!user) return res.status(404).json({ error_code: 'USER_PROFILE_NOT_FOUND' });
  res.json({ state: parseOnboardingState(user), steps: onboardingSteps(email) });
});

/** Persistierten Onboarding-State teilweise aktualisieren
 *  (welcomeDismissed / completed). */
router.patch('/onboarding', jsonBody, (req, res) => {
  const email = sessionEmail(req);
  const user = appUsers.getUser(email);
  if (!user) return res.status(404).json({ error_code: 'USER_PROFILE_NOT_FOUND' });
  const cur = parseOnboardingState(user);
  const body = req.body || {};
  const next = { ...cur };
  if (typeof body.welcomeDismissed === 'boolean') next.welcomeDismissed = body.welcomeDismissed;
  if (typeof body.completed === 'boolean') next.completed = body.completed;
  appUsers.setOnboardingState(email, next);
  res.json({ ok: true, state: next, steps: onboardingSteps(email) });
});

/** Beispielbuch anlegen (gemeinfreie Prosa, kein KI-Call). Idempotent pro User:
 *  existiert es schon, kommt dessen book_id zurueck (deduplicated=true). */
router.post('/onboarding/demo-book', async (req, res) => {
  const email = sessionEmail(req);
  try {
    const { createDemoBook } = require('../lib/demo-book');
    const result = await createDemoBook(email);
    setContext({ book: result.bookId });
    logger.info(`Beispielbuch ${result.deduplicated ? 'wiederverwendet' : 'angelegt'} (id=${result.bookId})`, { user: email });
    res.json({ ok: true, ...result });
  } catch (e) {
    logger.error(`Beispielbuch anlegen fehlgeschlagen: ${e.message}`, { user: email });
    res.status(500).json({ error_code: 'DEMO_BOOK_FAILED', detail: e.message });
  }
});

// User-Selbst-Invite. Gate via app_users.can_invite_users; Admins
// duerfen ueber /admin/users/invite mit role='admin' arbeiten, hier zwingend
// role='user'. Use-Case: Buch-Sharing-Dialog laedt frische Email ein.
router.post('/invite', jsonBody, (req, res) => {
  const inviter = sessionEmail(req);
  const me = appUsers.getUser(inviter);
  if (!me) return res.status(403).json({ error_code: 'NOT_REGISTERED' });
  if (me.status !== 'active') return res.status(403).json({ error_code: 'NOT_ACTIVE' });
  if (!me.can_invite_users && me.global_role !== 'admin') {
    return res.status(403).json({ error_code: 'INVITE_FORBIDDEN' });
  }
  const email = (req.body?.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error_code: 'EMAIL_REQUIRED' });
  try {
    const invite = appUsers.createInvite({ email, globalRole: 'user', invitedBy: inviter });
    logger.info(`Self-Invite ausgestellt: ${email}`, { user: inviter });
    res.json({ invite });
  } catch (e) {
    logger.error(`Self-Invite: ${e.message}`, { user: inviter });
    res.status(500).json({ error_code: 'INVITE_FAILED', detail: e.message });
  }
});

// ── Device-Tokens (native Clients, z.B. Mac-Focus-Writer) ────────────────────
// Per-User-Bearer-Token. Klartext verlaesst den Server NUR einmal in der
// Create-Response; danach existiert in der DB ausschliesslich der Hash.

/** Liste der Device-Tokens des eingeloggten Users (ohne Klartext). */
router.get('/device-tokens', (req, res) => {
  const email = sessionEmail(req);
  res.json({ tokens: deviceTokens.listDeviceTokens(email) });
});

/** Neuen Device-Token ausstellen. Body: { device_name, platform?, kind? }.
 *  `kind` waehlt den Rechteumfang (siehe lib/device-scopes.js):
 *    'device'  — native Clients, volle Rechte des Users (Default)
 *    'capture' — Browser-Erweiterung, darf nur erfassen (Recherche + Quellen)
 *  Antwort enthaelt `plain_token` — wird nie wieder ausgegeben. */
router.post('/device-tokens', jsonBody, (req, res) => {
  const email = sessionEmail(req);
  // Device-Tokens duerfen nicht selbst ueber ein Device-Token ausgestellt werden
  // (kein Self-Minting offline): nur echte interaktive Sessions.
  if (req.session.user.via === 'device_token') {
    return res.status(403).json({ error_code: 'DEVICE_TOKEN_SELF_MINT_FORBIDDEN' });
  }
  const deviceName = String(req.body?.device_name || '').trim();
  if (!deviceName) return res.status(400).json({ error_code: 'DEVICE_NAME_REQUIRED' });
  const platform = req.body?.platform ? String(req.body.platform).trim() : null;
  // Unbekannte Art waere ein stiller Rechte-Unfall in beide Richtungen —
  // 400 statt Default-Fallback.
  const kind = req.body?.kind === undefined || req.body.kind === null
    ? DEFAULT_KIND
    : String(req.body.kind).trim();
  if (!Object.prototype.hasOwnProperty.call(TOKEN_KINDS, kind)) {
    return res.status(400).json({
      error_code: 'INVALID_VALUE',
      params: { field: 'kind', allowed: Object.keys(TOKEN_KINDS).join(', ') },
    });
  }
  try {
    const tok = deviceTokens.createDeviceToken({
      userEmail: email, deviceName, platform, scopes: scopesForKind(kind),
    });
    logger.info(`Device-Token ausgestellt: "${tok.device_name}" (${kind})`, { user: email });
    res.json({ token: tok });
  } catch (e) {
    logger.error(`Device-Token create: ${e.message}`, { user: email });
    res.status(500).json({ error_code: 'DEVICE_TOKEN_CREATE_FAILED', detail: e.message });
  }
});

/** Device-Token widerrufen (Soft-Revoke, sofort ungueltig). */
router.post('/device-tokens/:id/revoke', (req, res) => {
  const email = sessionEmail(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error_code: 'INVALID_ID' });
  // Fixe Demo-Tokens aus ENV sind nicht ueber die UI entziehbar (siehe
  // lib/demo-user.js#isFixedDemoToken) — sonst schaltet ein Klick im
  // Demo-Profil den nativen Zugang bis zum naechsten Serverstart ab.
  if (require('../lib/demo-user').isFixedDemoToken(id)) {
    return res.status(403).json({ error_code: 'DEMO_TOKEN_FIXED' });
  }
  const ok = deviceTokens.revokeDeviceToken(id, email);
  if (!ok) return res.status(404).json({ error_code: 'TOKEN_NOT_FOUND' });
  logger.info(`Device-Token widerrufen (id=${id})`, { user: email });
  res.json({ ok: true });
});

/** Device-Token endgueltig loeschen. */
router.delete('/device-tokens/:id', (req, res) => {
  const email = sessionEmail(req);
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error_code: 'INVALID_ID' });
  if (require('../lib/demo-user').isFixedDemoToken(id)) {
    return res.status(403).json({ error_code: 'DEMO_TOKEN_FIXED' });
  }
  const ok = deviceTokens.deleteDeviceToken(id, email);
  if (!ok) return res.status(404).json({ error_code: 'TOKEN_NOT_FOUND' });
  logger.info(`Device-Token geloescht (id=${id})`, { user: email });
  res.json({ ok: true });
});

// ── Konto-Selbstloeschung ────────────────────────────────────────────────────
//
// DELETE /me/account, Body { confirm: 'DELETE' }.
//
// Anlass: App-Store-Guideline 5.1.1(v) — ein Konto, das sich in der App anlegen
// laesst, muss sich in der App loeschen lassen. Aufrufer sind der native
// macOS-Client (schreibwerkstatt-focuseditor) und das Profil der Web-App.
//
// AUTH BEWUSST OHNE EINSCHRAENKUNG DER ART: der Endpunkt muss mit Device-Token
// (Bearer swd_…) funktionieren, weil der native Client keine Session hat und die
// Guideline die Loeschung IN DER APP verlangt. Anders als POST /me/device-tokens
// (dort 403 DEVICE_TOKEN_SELF_MINT_FORBIDDEN, kein Self-Minting offline) gibt es
// hier also kein `via === 'device_token'`-Gate. Ein `capture:write`-Token der
// Browser-Erweiterung kommt trotzdem nicht durch — /me/ steht in keiner
// Allowlist von lib/device-scopes.js und faellt dort mit 403.
//
// `confirm` ist ein konstanter Protokollwert ('DELETE'), NICHT lokalisiert und
// nicht der Buchtitel o.ae.: die Absicherung gegen den Fehlklick sitzt im UI,
// dieser Wert sichert nur gegen den versehentlichen Request.
//
// Was geloescht wird, was anonymisiert bleibt und warum: siehe den Kopf von
// lib/account-delete.js — dort liegt auch die vollstaendige Spaltenliste.
//
// Antwortformen (der Client wertet genau diese aus):
//   200 { ok: true }                       — geloescht (bzw. Demo-Konto: zurueckgesetzt).
//                                            Kein `scheduled_purge_at` — es gibt keine
//                                            Karenzfrist, geloescht wird sofort.
//   400 { error_code: 'CONFIRM_REQUIRED' }
//   403 { error_code: 'ACCOUNT_DELETE_FORBIDDEN' }
//   404 { error_code: 'USER_NOT_FOUND' }   — fachlicher Fehler MIT Code; ein 404
//                                            OHNE error_code deutet der Client als
//                                            „Server kennt die Route nicht".
router.delete('/account', jsonBody, async (req, res) => {
  const email = sessionEmail(req);
  const ip = (req.ip || '').toString() || null;
  const userAgent = req.headers['user-agent'] || null;

  if (String(req.body?.confirm || '') !== 'DELETE') {
    return res.status(400).json({ error_code: 'CONFIRM_REQUIRED' });
  }

  const user = appUsers.getUser(email);
  if (!user) return res.status(404).json({ error_code: 'USER_NOT_FOUND' });

  // Zwei Konten duerfen sich nicht selbst loeschen, beide aus demselben Grund:
  // die Instanz waere danach nicht mehr administrierbar.
  //   ADMIN_EMAIL — wird bei jedem Serverstart aus der ENV neu angelegt
  //     (appUsers.ensureAdminFromEnv). Eine Loeschung raeumt die Inhalte ab und
  //     der naechste Boot legt ein leeres Konto derselben Adresse wieder an: ein
  //     Zustand, den niemand gewollt hat.
  //   Letzter aktiver Admin — ohne ihn kann niemand mehr Nutzer freischalten
  //     oder Einstellungen aendern.
  const envAdmin = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const isEnvAdmin = !!envAdmin && envAdmin === email.toLowerCase();
  const admins = appUsers.getActiveAdminEmails().map(a => a.toLowerCase());
  const isLastAdmin = user.global_role === 'admin'
    && admins.length <= 1 && admins.includes(email.toLowerCase());
  if (isEnvAdmin || isLastAdmin) {
    logger.warn(`Konto-Selbstloeschung abgelehnt (${isEnvAdmin ? 'ENV-Admin' : 'letzter Admin'})`, { user: email });
    return res.status(403).json({ error_code: 'ACCOUNT_DELETE_FORBIDDEN' });
  }

  // Demo-Zugang: echter Reset statt Loeschung (Begruendung in
  // lib/account-delete.js#resetDemoAccount). Der Pruefer sieht den vollstaendigen
  // Ablauf, die Demo bleibt fuer den naechsten nutzbar.
  const demo = require('../lib/demo-user');
  const isDemo = demo.isEnabled() && demo.demoEmail() === email.toLowerCase();

  try {
    const accountDelete = require('../lib/account-delete');
    if (isDemo) {
      const r = await accountDelete.resetDemoAccount(email, { ip, userAgent });
      // Session NICHT zerstoeren und Tokens NICHT widerrufen: das Konto besteht
      // weiter, und der Pruefer soll die neu gesaeten Buecher gleich sehen.
      return res.json({ ok: true, demo_reset: true, books_removed: r.books, reseeded: r.reseeded });
    }

    await accountDelete.deleteAccount(email, { ip, userAgent });
    // Session-Cookie entwerten. Device-Tokens sind bereits geloescht — ab hier
    // beantwortet der Auth-Guard jeden Bearer-Request mit 401.
    req.session.destroy(() => res.json({ ok: true }));
  } catch (e) {
    logger.error(`Konto-Selbstloeschung fehlgeschlagen: ${e.message}`, { user: email });
    if (!res.headersSent) res.status(500).json({ error_code: 'ACCOUNT_DELETE_FAILED', detail: e.message });
  }
});

module.exports = router;
