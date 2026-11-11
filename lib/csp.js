'use strict';
// Content-Security-Policy der App.
//
// Alle Skripte/Styles/Fonts self-hosted (vendor/ + js/ + css/ + fonts/).
// 'unsafe-eval' ist Pflicht für Alpine.js v3 (kompiliert Direktiven dynamisch).
// script-src bekommt NIE 'unsafe-inline': die CSP ist die zweite, tragende
// Schicht hinter dem Sanitizer (lib/html-clean.js#stripActiveContent) — mit
// 'unsafe-inline' waere injiziertes Markup sofort ausfuehrbarer Code.
// 'unsafe-inline' bei style-src ist nötig, weil Alpine `:style` zur Laufzeit
// inline-style-Attribute setzt (z.B. progress-bar via --progress).
// img-src deckt data:/blob: für Generated Charts/Graphs plus
// *.googleusercontent.com für Google-Profilbilder im Avatar-Menü plus
// *.tile.openstreetmap.org für die Leaflet-Karte der Schauplätze plus den
// Host eines self-hosted Tile-Servers (geocode.tiles.url) und des Luftbild-
// Servers (geocode.tiles.satellite.url), zur Laufzeit ergänzt.
// connect-src 'self' deckt alle XHR/SSE-Endpunkte (Server proxy'd Anthropic +
// Ollama; Storage geht ueber /content/*); Plausible-Origin wird zur Laufzeit
// aus app_settings ergänzt, falls Analytics aktiv ist.

const appSettings = require('./app-settings');

function plausibleOriginFromSettings() {
  if (!appSettings.get('analytics.plausible.enabled')) return '';
  const url = String(appSettings.get('analytics.plausible.script_url') || '').trim();
  if (!url) return '';
  try { return new URL(url).origin; }
  catch { return ''; }
}

// CSP-img-src-Quelle aus der konfigurierten Tile-Server-URL (geocode.tiles.url).
// Leaflet laedt die Kacheln direkt im Browser, also muss der Host im img-src
// stehen. Das {s}-Subdomain-Token wird zum Wildcard-Host (https://*.host); ohne
// {s} liefert die Origin den exakten Host:Port. Leer/ungueltig → kein Eintrag.
function tileImgSrcFromSettings(key = 'geocode.tiles.url') {
  const tpl = String(appSettings.get(key) || '').trim();
  if (!tpl) return '';
  const hasSub = tpl.includes('{s}');
  try {
    const probe = tpl.replace('{s}', 'a').replace(/\{[zxy]\}/g, '0');
    const u = new URL(probe);
    return hasSub ? `${u.protocol}//*.${u.host.replace(/^a\./, '')}` : u.origin;
  } catch { return ''; }
}

function buildCspHeader() {
  const plausible = plausibleOriginFromSettings();
  const tileSrc    = tileImgSrcFromSettings();
  const satSrc     = tileImgSrcFromSettings('geocode.tiles.satellite.url');
  const scriptSrc  = ["'self'", "'unsafe-eval'", ...(plausible ? [plausible] : [])];
  const styleSrc   = ["'self'", "'unsafe-inline'"];
  const imgSrc     = ["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com', 'https://*.tile.openstreetmap.org', ...(tileSrc ? [tileSrc] : []), ...(satSrc ? [satSrc] : [])];
  const fontSrc    = ["'self'"];
  const connectSrc = ["'self'", ...(plausible ? [plausible] : [])];
  const frameSrc   = ["'self'"];
  const dir = {
    'default-src':  ["'self'"],
    'script-src':   scriptSrc,
    'style-src':    styleSrc,
    'img-src':      imgSrc,
    'font-src':     fontSrc,
    // TTS / Proof-Listening: das synthetisierte Audio kommt vom /tts/speak-Proxy
    // (same-origin) und wird als blob:-Object-URL abgespielt.
    'media-src':    ["'self'", 'blob:'],
    'connect-src':  connectSrc,
    'frame-src':    frameSrc,
    // ALTCHA loest das PoW in einem Blob-Web-Worker.
    'worker-src':   ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'object-src':   ["'none'"],
    'base-uri':     ["'self'"],
    'frame-ancestors': ["'self'"],
    'form-action':  ["'self'"],
  };
  return Object.entries(dir).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ');
}

const CSP_SETTING_KEYS = new Set(['analytics.plausible.enabled', 'analytics.plausible.script_url', 'geocode.tiles.url', 'geocode.tiles.satellite.url']);

/** Middleware, die den gecachten CSP-Header setzt; Rebuild bei Setting-Wechsel. */
function cspMiddleware() {
  let header = buildCspHeader();
  appSettings.on('changed', (evt) => {
    if (evt?.key && CSP_SETTING_KEYS.has(evt.key)) header = buildCspHeader();
  });
  return function csp(req, res, next) {
    res.setHeader('Content-Security-Policy', header);
    next();
  };
}

module.exports = { buildCspHeader, cspMiddleware, plausibleOriginFromSettings, tileImgSrcFromSettings };
