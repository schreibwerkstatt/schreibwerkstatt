require('dotenv').config();
// Async-Handler-Rejections an die Express-Fehlerkette reichen (vor jedem Router).
require('./lib/async-routes').install();
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { runWithContext } = require('./lib/log-context');
const { setSessionFingerprintCookie } = require('./lib/session-fingerprint');

// DB-Setup + Migrationen laufen beim Import
const { db } = require('./db/schema');
const appUsers = require('./db/app-users');
const { tokenAwareSession } = require('./lib/token-session');
const { deviceScopeGate } = require('./lib/device-scopes');
const { ensureAdminFromEnv, touchUserLastSeen, addUserActivity } = appUsers;
const appSettings = require('./lib/app-settings');
const { getVersion } = require('./lib/version');
const { normalizeAnalyticsUrl, analyticsProps } = require('./lib/analytics-url');

// Admin-Bootstrap: ADMIN_EMAIL aus ENV → app_users-Row mit
// global_role='admin'. Idempotent + ENV-Wechsel-tauglich (kein Restart-Zwang).
try {
  const r = ensureAdminFromEnv();
  if (r && r.action !== 'exists') logger.info(`ADMIN_EMAIL ${r.email}: ${r.action}`);
} catch (e) {
  logger.warn(`ensureAdminFromEnv: ${e.message}`);
}

// Settings-Bootstrap: ENV-Werte einmalig in app_settings spiegeln,
// solange noch keine DB-Row existiert. Idempotent — bestehende DB-Werte
// werden nicht ueberschrieben.
try { appSettings.bootstrapFromEnv(); }
catch (e) { logger.warn(`app-settings.bootstrapFromEnv: ${e.message}`); }

// Devmode-Seed: nur bei LOCAL_DEV_MODE + app.backend='localdb' und
// leerer books-Tabelle. Idempotent durch COUNT-Check.
try {
  const { runDevSeedIfNeeded } = require('./lib/dev-seed');
  runDevSeedIfNeeded();
} catch (e) { logger.warn(`runDevSeedIfNeeded: ${e.message}`); }

// Demo-Zugang-Bootstrap (nur wenn DEMO_EMAIL + DEMO_PASSWORD gesetzt sind):
// app_users-Row + fixe Device-Tokens aus ENV. Muss beim BOOT laufen und nicht
// erst beim ersten Login — die nativen Clients und die Browser-Erweiterung
// authentisieren per Bearer-Token und rufen die Login-Seite nie auf. Idempotent.
// Details + Betriebsregeln: lib/demo-user.js.
try {
  const demoUser = require('./lib/demo-user');
  if (demoUser.isEnabled()) {
    demoUser.ensureDemoAccess();
    // Beispielbuch asynchron nachziehen (Content-Store ist async), damit auch ein
    // Reviewer, der ausschliesslich im nativen Client arbeitet, Inhalt sieht.
    setImmediate(() => {
      demoUser.seedDemoContent(demoUser.demoEmail()).catch(() => {});
    });
  }
} catch (e) { logger.warn(`demo-user.ensureDemoAccess: ${e.message}`); }

// Initial-Reindex der FTS5-Tabellen, wenn die Marker-Row gesetzt ist.
// In setImmediate, damit Boot nicht blockiert.
setImmediate(() => {
  try {
    const searchIndex = require('./lib/search');
    searchIndex.reindexIfNeeded();
  } catch (e) { logger.warn(`searchIndex.reindexIfNeeded: ${e.message}`); }
});

const authRouter = require('./routes/auth');
const historyRouter = require('./routes/history');
const figuresRouter = require('./routes/figures');
const figuresAlterRouter = require('./routes/figures-alter');
const locationsRouter = require('./routes/locations');
const songsRouter = require('./routes/songs');
const { router: jobsRouter } = require('./routes/jobs');
const chatRouter = require('./routes/chat');
const ideenRouter = require('./routes/ideen');
const researchRouter = require('./routes/research');
const sourcesRouter = require('./routes/sources');
const xrefsRouter = require('./routes/xrefs');
const plotRouter = require('./routes/plot');
const motifsRouter = require('./routes/motifs');
const bookSettingsRouter = require('./routes/booksettings');
const userSettingsRouter = require('./routes/usersettings');
const { router: proxiesRouter } = require('./routes/proxies');
const { router: syncRouter } = require('./routes/sync');
const exportRouter = require('./routes/export');
const bookMigrationRouter = require('./routes/book-migration');
const pdfExportRouter = require('./routes/pdf-export');
const usageRouter = require('./routes/usage');
const { router: draftFiguresRouter } = require('./routes/draft-figures');
const contentRouter = require('./routes/content');
const snapshotsRouter = require('./routes/snapshots');
const shareRouter = require('./routes/share');

const PORT = process.env.PORT || 3737;
const app = express();

// Hinter einem Reverse-Proxy (NGINX, NPM, Traefik …) echte Client-IP
// und req.secure korrekt auswerten lassen.
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));

// CSP: lib/csp.js (script-src ohne 'unsafe-inline', Rebuild bei Setting-Wechsel).
app.use(require('./lib/csp').cspMiddleware());

// gzip aktiv, aber SSE-Streams (text/event-stream) und Responses mit
// `x-no-compression` ausgenommen — Kompression würde Stream-Chunks bis zum
// Buffer-Flush zurückhalten und Live-Updates blockieren.
app.use(compression({
  filter(req, res) {
    if (req.headers['x-no-compression']) return false;
    const ct = res.getHeader('Content-Type');
    if (typeof ct === 'string' && ct.includes('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}));

// ── Session ──────────────────────────────────────────────────────────────────
const LOCAL_DEV_MODE = process.env.LOCAL_DEV_MODE === 'true';

// Secret-Policy:
//   Production → SESSION_SECRET ist Pflicht (sonst Exit).
//   Dev-Mode   → falls nicht gesetzt, ein prozesslokaler Zufallsstring (Sessions
//                 gehen beim Restart verloren; keine deterministische Default-Konstante).
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  if (LOCAL_DEV_MODE) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    process.env.SESSION_SECRET = sessionSecret;
    logger.warn('SESSION_SECRET nicht gesetzt – zufälliges Dev-Secret generiert (Sessions überleben Restart nicht).');
  } else {
    logger.error('SESSION_SECRET nicht gesetzt – Server wird gestoppt. Bitte in .env setzen.');
    process.exit(1);
  }
}

const sessionStore = new SqliteStore({
  client: db,
  expired: { clear: true, intervalMs: 15 * 60 * 1000 }, // alle 15 min abgelaufene Sessions löschen
});
// Index auf expire — Store-GC scannt `WHERE datetime('now') > datetime(expire)`.
db.prepare('CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire)').run();

// Token-Requests (Metrics-Scraper, native Clients) laufen an express-session
// vorbei auf einer In-Memory-Session — sonst eine DB-Zeile pro Request, siehe
// lib/token-session.js.
app.use(tokenAwareSession(session({
  store: sessionStore,
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 Tage
    // `'auto'` leitet `secure` aus `req.secure` ab — funktioniert dank
    // `app.set('trust proxy', 1)` hinter NGINX/Traefik via `X-Forwarded-Proto`.
    // Eliminiert die Abhängigkeit zu APP_URL beim Boot (jetzt in app_settings).
    secure: 'auto',
    httpOnly: true,
    sameSite: 'lax',
  },
})));

if (LOCAL_DEV_MODE) {
  logger.warn('LOCAL_DEV_MODE aktiv – OAuth wird übersprungen, automatische Dev-Session!');
}

// ALS-Logging-Context: jeder logger.*-Call innerhalb des Request-Scopes erbt
// scope/user automatisch. Selbst silent — eigentliches Page-Load-Logging
// passiert weiter unten kurz vor staticServe.
app.use((req, res, next) => {
  const reqId = crypto.randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', reqId);
  runWithContext({
    job: 'http',
    user: req.session?.user?.email || null,
  }, () => next());
});

// ── Auth-Routen (öffentlich) ──────────────────────────────────────────────────
app.use(authRouter);

// ── Public-Routen (vor Auth-Guard) ───────────────────────────────────────────
// /landing, /register (GET+POST) und Unauth-Override fuer GET /. Eingeloggte
// und LOCAL_DEV_MODE laufen ueber `next()` weiter — Guard + staticServe
// liefern dann die SPA-Shell.
app.use(require('./routes/public'));

// /share/:token Reader-View + POST /share/:token/comment sind oeffentlich.
// Owner-API-Routen /share/api/* sind hingegen auth-pflichtig — die Auth-
// Routinen pruefen die Session selbst (requireSession-Mw).
app.use('/share', shareRouter);

// Plausible-Bootstrap dynamisch rendern: enabled+URL aus app_settings.
// Disabled oder leere URL → no-op JS (kein Tracking, keine Console-Error).
// Admin-Toggle ist die einzige Aktivierungs-Bedingung — keine Host-/Env-Filter.
// Vor dem Auth-Guard, damit Landing/Login/Register/Share das Script ebenfalls
// laden. Cache-Control: no-store, damit Toggle ohne Browser-Reload-Hack greift.
//
// `?surface=…` (+ bei Share `?kind=…`) benennt die aufrufende Oberflaeche und
// wird als Property mitgeschickt. Der Umweg ueber die Query ist Pflicht, nicht
// Geschmack: die CSP fuehrt kein 'unsafe-inline' fuer script-src, ein Inline-
// Snippet auf der Seite koennte die Werte also gar nicht setzen.
const ANALYTICS_SURFACES = new Set(['app', 'landing', 'register', 'datenschutz', 'share', 'share-abgelaufen']);
const ANALYTICS_SHARE_KINDS = new Set(['page', 'chapter', 'book']);

app.get('/js/plausible-init.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const enabled = !!appSettings.get('analytics.plausible.enabled');
  const scriptUrl = String(appSettings.get('analytics.plausible.script_url') || '').trim();
  if (!enabled || !scriptUrl) {
    return res.send('/* plausible disabled */\n');
  }
  const surface = String(req.query.surface || '');
  const kind = String(req.query.kind || '');
  const base = {};
  if (ANALYTICS_SURFACES.has(surface)) base.oberflaeche = surface;
  if (ANALYTICS_SHARE_KINDS.has(kind)) base.umfang = kind;

  const safeUrl = JSON.stringify(scriptUrl);
  const safeBase = JSON.stringify(base);
  res.send(
    `// Plausible-Bootstrap. URL aus Admin-Settings (analytics.plausible.script_url).\n` +
    `// Die beiden Funktionen sind der woertliche Quelltext aus lib/analytics-url.js\n` +
    `// (eine Quelle fuer Browser und Test, siehe Kommentar dort).\n` +
    `(function () {\n` +
    `  var BASE = ${safeBase};\n` +
    `  ${normalizeAnalyticsUrl.toString().replace(/\n/g, '\n  ')}\n` +
    `  ${analyticsProps.toString().replace(/\n/g, '\n  ')}\n` +
    `  var s = document.createElement('script');\n` +
    `  s.async = true;\n` +
    `  s.src = ${safeUrl};\n` +
    `  document.head.appendChild(s);\n` +
    `  window.plausible = window.plausible || function () { (plausible.q = plausible.q || []).push(arguments); };\n` +
    `  plausible.init = plausible.init || function (i) { plausible.o = i || {}; };\n` +
    `  plausible.init({\n` +
    `    hashBasedRouting: true,\n` +
    // transformRequest statt customProperties: die Web-Variante des Trackers hat
    // transformRequest immer einkompiliert, customProperties haengt dagegen am
    // Dashboard-Schalter — und nur transformRequest kann ausserdem die URL
    // aufraeumen. Ein Hebel fuer beide Aufgaben.
    `    transformRequest: function (payload) {\n` +
    `      payload.u = normalizeAnalyticsUrl(payload.u);\n` +
    `      payload.p = Object.assign(\n` +
    `        analyticsProps(BASE, window.__plausibleProps, document, window),\n` +
    `        payload.p || {}\n` +
    `      );\n` +
    `      return payload;\n` +
    `    },\n` +
    `  });\n` +
    `})();\n`
  );
});

// ── Öffentliche PWA-Assets (vor Auth-Guard) ──────────────────────────────────
// Browser holen manifest.webmanifest und sw.js ohne Credentials; hinter dem
// Auth-Guard würde das in einen Google-OIDC-Redirect laufen und CORS-Fehler werfen.
const PUBLIC_ASSETS = new Set([
  '/manifest.webmanifest',
  '/sw.js',
  '/icon-192.png',
  '/icon-512.png',
  '/schreibwerkstatt_icon.svg',
  // Lucide-Icon-Sprite: der Share-Reader-Vorlese-Dock (share-reader/tts.js)
  // referenziert Icons via <use href="/icons.svg#…">. Ohne Freigabe landet der
  // Request des ANONYMEN Lesers im Auth-Guard, kommt als HTML zurueck und der
  // <use>-Verweis loest nie auf → die Dock-Icons bleiben unsichtbar.
  '/icons.svg',
  '/schreibwerkstatt_icon.ico',
  '/favicon.ico',
  // Asset-Liste + Content-Hash des Service Workers. sw.js zieht die Datei als
  // ERSTES per importScripts — sie ist damit genauso pre-auth-pflichtig wie der
  // SW selbst. Faellt die Session aus, kaeme sonst Login-HTML zurueck und die
  // SW-Auswertung scheiterte an nosniff.
  '/sw-manifest.js',
  // ALTCHA-PoW-Widget (Custom-Element): von register.html + /login per
  // dynamic `<script type="module">` nachgeladen, sobald ALTCHA aktiv ist.
  '/vendor/altcha-3.0.11.min.js',
  // mermaid: share-reader/diagrams.js laedt die Lib nach, wenn der geteilte Text
  // einen `pre.mermaid` enthaelt. Ohne Freigabe bekaeme der ANONYME Leser die
  // Login-HTML statt des Skripts und saehe statt des Diagramms dessen Quelltext.
  // Einzelfreigabe statt eines `/vendor/`-Prefix: der Reader braucht genau diese
  // eine Datei, alle uebrigen Vendor-Libs gehoeren hinter den Auth-Guard.
  '/vendor/mermaid-11.16.0.min.js',
]);
// Pre-auth-erlaubte Prefixes: landing.html + register.html ziehen /css/tokens.css
// + /css/landing.css (+ deren @import-Sub-Tokens) und Variable-Fonts aus /fonts/.
// Ohne diese Freigabe landen die Requests im Auth-Guard und werden als HTML
// (`/login?returnTo=...`) zurückgegeben → Browser verweigert das Stylesheet wegen
// falschem MIME-Type.
//
// /js/ steht aus demselben Grund vollstaendig offen, und zwar fuer BEIDE Seiten:
//  - Der anonyme Leser braucht den kompletten Share-Reader-Modulgraph
//    (/js/share-reader/* plus die geteilten Module share-anchor, avatar,
//    scroll-fade, comment-card-layout, tts-segment, tts-player, editor/comment-threads) sowie
//    die Skripte der Pre-Auth-Seiten (credential-login, register, share-theme-init).
//  - Der EINGELOGGTE User braucht ihn, weil der Service Worker die Shell
//    cache-only bedient: ein einzelner evictierter Eintrag (v.a. iOS) geht als
//    Notnagel ans Netz, und faellt in genau diesem Moment die Session aus, kam
//    frueher ein 302 auf /login zurueck. Fuer `<script type="module">` und
//    `<link rel="modulepreload">` heisst das: HTML statt JS, nosniff verweigert
//    das Modul, die App bootet nicht — sichtbar nur als "SCRIPT/LINK nicht
//    ladbar" im Fehler-Log. Client-Code ist kein Geheimnis (Stylesheets stehen
//    seit je offen), deshalb faellt die Gate-Ebene hier weg statt die Fehlerlage
//    ehrlicher zu machen.
// Ausnahme bleibt /js/plausible-init.js: die Route davor rendert es aus
// app_settings und greift zuerst.
//
// Das entbindet den Reader NICHT von seiner Import-Disziplin — er darf weiterhin
// nur aus /js/share-reader/ importieren (Kopplung + Bundle-Groesse), gegated
// durch block-sel-consolidation/cite-guard-drift/mermaid-drift.
const PUBLIC_ASSET_PREFIXES = ['/css/', '/fonts/', '/js/'];
// Statische Assets: `no-cache` für alles ausser Bildern. ETag bleibt aktiv —
// Browser revalidiert bei jedem Reload mit If-None-Match (304 wenn unverändert,
// nur Header-Roundtrip, keine Bytes). Bilder/Icons halten 7 Tage, weil sie sich
// praktisch nie ändern.
const staticServe = express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    // Positiv-Marker der SPA-Shell fuer den Service Worker. Er ist noetig, weil
    // `GET /` unter EINER URL zwei verschiedene Dokumente liefert: eingeloggt
    // die Shell (dieses index.html), anonym die Landing-Seite (routes/public.js)
    // — beide mit 200. Ein URL-Cache kann die zwei nicht auseinanderhalten;
    // ohne Marker legt der SW bei abgelaufener Session die Landing-Seite als
    // Shell ab und bedient sie danach cache-only weiter (nur Hard-Refresh
    // kommt daran vorbei). Der SW cacht und serviert `/` nur mit diesem Header,
    // siehe public/sw.js#isShellResponse.
    if (/(?:^|[\\/])index\.html$/i.test(filePath)) {
      res.setHeader('X-App-Shell', '1');
    }
    // sw.js darf nie HTTP-gecached werden, sonst frieren Clients auf alter
    // Service-Worker-Version fest und sehen Asset-Updates nicht.
    if (/(?:^|[\\/])sw\.js$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (/\.(png|jpe?g|gif|webp|ico|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    } else {
      // SVG-Sprites zählen als Code (Icon-Set wird editiert) — wie JS/CSS via
      // ETag revalidieren, sonst halten Browser bis zu 7 Tage alte Versionen.
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
});
app.use((req, res, next) => {
  if (req.method === 'GET' && (
    PUBLIC_ASSETS.has(req.path) ||
    PUBLIC_ASSET_PREFIXES.some(p => req.path.startsWith(p))
  )) {
    return staticServe(req, res, next);
  }
  next();
});

// ── Prometheus-Endpoint (vor Auth-Guard) ─────────────────────────────────────
// /metrics + /metrics.json nutzen Bearer-Token-Auth (lib/bearer-auth, Scope
// `metrics:read`). Mount muss VOR dem Session-Guard liegen, sonst redirected
// der Guard externe Scraper (HA/Prometheus/Grafana) auf /login. Die Routen
// validieren den Token selbst und setzen req.session.user falls gueltig;
// ungueltige Tokens enden in 401 JSON ohne Redirect. Volle Pfade im Router,
// darum Mount an der Wurzel.
app.use(require('./routes/metrics'));

// ── Auth-Guard ────────────────────────────────────────────────────────────────
// Session oder Device-Token; ohne Anmeldung bekommt nur eine Browser-Navigation
// den Redirect auf /login, jeder andere Request 401 JSON (lib/auth-guard.js).
app.use(require('./lib/auth-guard').makeAuthGuard({ localDevMode: LOCAL_DEV_MODE }));

// ── Device-Scope-Gate ────────────────────────────────────────────────────────
// Muss direkt hinter dem Auth-Guard liegen (der setzt req.session.user samt
// scopes) und VOR jedem Route-Mount. Betrifft nur Requests via Device-Token:
// ein `capture:write`-Token (Browser-Erweiterung) kommt nur an die Erfassungs-
// Endpunkte, `content:write` (native Clients) bleibt ungegated.
app.use(deviceScopeGate);

// ── Aktivitäts-Tracking ──────────────────────────────────────────────────────
// Pro authentifiziertem Request wird die Differenz zum letzten Request als aktive
// Zeit gezählt – aber nur, wenn die Lücke < 5 min ist (danach gilt der User als
// weg gewesen). `app_users.last_seen_at` wird nur alle 60 s in die DB geschrieben,
// um Write-Last niedrig zu halten.
const ACTIVITY_GAP_MS      = 5 * 60 * 1000;
const LAST_SEEN_THROTTLE_MS = 60 * 1000;
app.use((req, res, next) => {
  const email = req.session?.user?.email;
  if (!email) return next();
  const now  = Date.now();
  const last = req.session.lastSeen || 0;
  const delta = now - last;
  if (delta > 0 && delta < ACTIVITY_GAP_MS) {
    try { addUserActivity(email, delta / 1000, new Date(now).toISOString()); }
    catch (e) { logger.warn('addUserActivity: ' + e.message); }
  }
  if (!req.session.loginAt) req.session.loginAt = now; // Fallback für Sessions aus Zeit vor diesem Feature
  req.session.lastSeen = now;
  // Rueckfall fuer den Sitzungs-Fingerprint (lib/session-fingerprint.js): die
  // Login-Antworten setzen ihn selbst, hier bekommt ihn jede Session, die es
  // schon vor diesem Cookie gab. Setzt nur bei Abweichung, also einmal.
  setSessionFingerprintCookie(req, res);
  if (now - (req.session.lastSeenPersisted || 0) > LAST_SEEN_THROTTLE_MS) {
    try { touchUserLastSeen(email, new Date(now).toISOString()); }
    catch (e) { logger.warn('touchUserLastSeen: ' + e.message); }
    req.session.lastSeenPersisted = now;
  }
  next();
});

// ── Geschützte Routen ────────────────────────────────────────────────────────
app.use(proxiesRouter);
app.use('/history', historyRouter);
app.use('/figures', figuresAlterRouter);
app.use('/figures', figuresRouter);
app.use('/locations', locationsRouter);
app.use('/world-facts', require('./routes/world-facts'));
app.use('/geocode', require('./routes/geocode'));
app.use('/tiles', require('./routes/tiles'));
app.use('/songs', songsRouter);
app.use('/redundancy', require('./routes/redundancy'));
app.use('/jobs', jobsRouter);
app.use('/events', require('./routes/events'));
app.use('/chat', chatRouter);
app.use('/ideen', ideenRouter);
app.use('/research', researchRouter);
app.use('/sources', sourcesRouter);
// Sammel-Endpunkt der Browser-Erweiterung: Fundstueck + Quelle in einem
// transaktionalen Aufruf (siehe routes/capture.js).
app.use('/capture', require('./routes/capture'));
app.use('/xrefs', xrefsRouter);
app.use('/plot', plotRouter);
app.use('/motifs', motifsRouter);
app.use('/lexicon', require('./routes/lexicon'));
app.use('/textsorte', require('./routes/textsorte'));
app.use('/redaktion', require('./routes/redaktion'));
app.use('/headline', require('./routes/headline'));
app.use('/booksettings', bookSettingsRouter);
app.use('/changelog', require('./routes/changelog'));
// Buecherregal vor /me: eigener Router (usersettings.js ist eine LOC-Altlast),
// gleicher Mount-Praefix. Express probiert Router in Reihenfolge — /me/books
// gibt es in userSettingsRouter nicht, die Reihenfolge ist also nur Kosmetik.
app.use('/me/books', require('./routes/mybooks'));
// Autorenprofil: dieselbe Begruendung fuer einen eigenen Router wie beim Regal.
app.use('/me/author-profile', require('./routes/author-profile'));
// Eigener KI-Zugang: dieselbe Begruendung fuer einen eigenen Router wie beim Regal.
app.use('/me/ai-access', require('./routes/me-ai-access'));
app.use('/me', userSettingsRouter);
app.use('/sync', syncRouter);
app.use('/export', exportRouter);
app.use('/book-migration', bookMigrationRouter);
app.use('/pdf-export', pdfExportRouter);
app.use('/docx-export', require('./routes/docx-export'));
app.use('/publication', require('./routes/publication'));
app.use('/usage', usageRouter);
app.use('/telemetry', require('./routes/telemetry'));
app.use('/draft-figures', draftFiguresRouter);
app.use('/content', contentRouter);
app.use('/snapshots', snapshotsRouter);
app.use('/search', require('./routes/search'));
app.use('/languagetool', require('./routes/languagetool'));
app.use('/name-guard', require('./routes/name-guard'));
app.use('/stt', require('./routes/stt'));
app.use('/tts', require('./routes/tts'));
app.use('/dictionary', require('./routes/dictionary'));
app.use('/diagram', require('./routes/diagram'));
app.use('/books', require('./routes/book-access'));
app.use('/book-editor', require('./routes/book-editor'));
app.use('/admin/users', require('./routes/admin-users'));
app.use('/admin/books', require('./routes/admin-books'));
app.use('/admin/settings', require('./routes/admin-settings'));
app.use('/admin/ai-profiles',            require('./routes/admin-ai-profiles'));
app.use('/admin/usage', require('./routes/admin-usage'));
app.use('/admin/logs', require('./routes/admin-logs'));
app.use('/admin/parse-fails', require('./routes/admin-parse-fails'));
app.use('/admin/js-errors', require('./routes/admin-js-errors'));
app.use('/admin/registration-requests', require('./routes/admin-registration-requests'));
app.use('/admin/api-tokens',            require('./routes/admin-api-tokens'));
app.use('/admin/devices',               require('./routes/admin-devices'));
app.use('/admin/backup',                require('./routes/admin-backup'));
app.use('/local/categories', require('./routes/categories'));
app.use('/blog', require('./routes/blog'));
app.use('/hubspot', require('./routes/hubspot'));

// Logout: usage-Tabelle behält Einträge (User-Wiederkehr → Top-3 sofort wieder da).
// Wenn Datenschutz erforderlich, Cleanup über Job/Cron auf Last-Seen-Basis.

// Page-Load-Logging: nur echte SPA-Shell-Requests (Browser-Document, kein
// SW-Refetch, kein Asset-Call). Heuristik prüft sec-fetch-dest oder Accept.
app.use((req, _res, next) => {
  if (req.method === 'GET' && req.path === '/') {
    const dest = req.headers['sec-fetch-dest'];
    const accept = req.headers.accept || '';
    const isDoc = dest === 'document' || accept.startsWith('text/html');
    if (isDoc) {
      const ua = req.headers['user-agent'] || '-';
      logger.info(`page load (ua="${ua}")`);
    }
  }
  next();
});

app.use(staticServe);

// Finaler JSON-Fehler-Handler: fängt synchrone Throws UND (dank
// lib/async-routes#install) Rejections von async-Handlern.
app.use(require('./lib/async-routes').errorHandler);

const server = app.listen(PORT, '0.0.0.0', () => {
  logger.info(`${appSettings.get('app.name')} v${getVersion()} läuft auf http://0.0.0.0:${PORT}`);
  require('./lib/startup').runStartupTasks({ localDevMode: LOCAL_DEV_MODE });
});

// ── Graceful Shutdown ────────────────────────────────────────────────────────
// systemd schickt SIGTERM, Ctrl+C schickt SIGINT. Ohne Handler werden
// offene SSE-Streams und Jobs abrupt gekappt. 30 s Drain-Zeit für laufende Requests,
// danach `server.close()` + SQLite-Close. Kein Force-Kill von Jobs – die kommen
// beim nächsten Start via cleanupStuckJobRuns() wieder hoch.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} empfangen – Graceful Shutdown (max 30 s Drain)…`);
  const force = setTimeout(() => {
    logger.warn('Drain-Timeout erreicht – erzwinge Exit.');
    try { db.close(); } catch {}
    process.exit(1);
  }, 30000);
  force.unref();
  server.close(err => {
    clearTimeout(force);
    if (err) logger.error('server.close Fehler: ' + err.message);
    try { db.pragma('optimize'); } catch {}
    try { db.close(); } catch {}
    logger.info('Graceful Shutdown abgeschlossen.');
    process.exit(err ? 1 : 0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { message: err.message, stack: err.stack });
  shutdown('uncaughtException', err);
});

// Tägliche Cron-Jobs (node-cron) — lib/cron.js.
require('./lib/cron').registerCrons();
