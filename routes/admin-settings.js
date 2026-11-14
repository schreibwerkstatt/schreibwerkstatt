'use strict';
// Admin-Routen fuer app_settings. Hinter requireAdmin (lib/admin-mw.js).
//
// Endpoints:
//   GET   /admin/settings           — Liste aller Keys (encrypted maskiert)
//                                    + `auth`-Zustand des anfragenden Admins
//   PUT   /admin/settings           — Sammel-Speichern { values, reset }: erst
//                                    alles pruefen, dann eine Transaktion
//   GET   /admin/settings/:key      — Einzelwert (encrypted maskiert)
//   PUT   /admin/settings/:key      — Update (Sentinel "__unchanged__" fuer
//                                    encrypted ohne Re-Eingabe)
//   DELETE /admin/settings/:key     — Reset auf Default
//   POST  /admin/settings/models   — Modell-Liste eines konfigurierten Hosts
//   POST  /admin/settings/test-provider — Probe des Providers { provider, values }
//                                    mit den Formularwerten (auch ungespeichert)
//   POST  /admin/settings/test-oauth    — Discovery-Doc-Fetch (Format-Check)
//
// Sicherheit: encrypted-Werte verlassen den Server nur als "__masked__" mit
// letzten 4 Zeichen als Hint. Wer den Klartext braucht (Backup, Debug):
// Direkter DB-Zugriff vom Server.

const express = require('express');
const appSettings = require('../lib/app-settings');
const { requireAdmin } = require('../lib/admin-mw');
const modelList = require('../lib/model-list');
const searxng = require('../lib/websearch/searxng');
const logger = require('../logger');
const { sessionEmail } = require('../lib/acl');
const { fetchWithTimeout } = require('../lib/http-util');
const creds = require('../db/user-credentials');

const router = express.Router();
router.use(requireAdmin);

// ENV-Notfallzugang (routes/auth/shell.js#/auth/admin-login) aktiv?
function _envAdminEnabled() {
  return !!(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD);
}

// Schutz gegen Selbst-Aussperren beim Wechsel auf `auth.method='local'`: die
// laufende Sitzung bleibt zwar gueltig, aber nach dem Abmelden kommt nur noch
// hinein, wer ein lokales Passwort hat. Ohne eigenes Passwort und ohne
// ENV-Notfallzugang waere der Admin draussen — und mit ihm jeder, der ihm ein
// Passwort setzen koennte. Liefert den error_code oder null.
function _authMethodLockoutCode(nextMethod, actor) {
  if (nextMethod !== 'local') return null;
  if (appSettings.get('auth.method') === 'local') return null;
  if (_envAdminEnabled()) return null;
  if (actor && creds.hasPassword(String(actor).toLowerCase())) return null;
  return 'AUTH_LOCAL_OWN_PASSWORD_REQUIRED';
}

router.get('/', (req, res) => {
  const items = appSettings.listForAdmin();
  const actor = sessionEmail(req);
  res.json({
    settings: items,
    auth: {
      own_has_password: !!actor && creds.hasPassword(String(actor).toLowerCase()),
      env_admin: _envAdminEnabled(),
    },
  });
});

// PUT /admin/settings { values: { key: value }, reset: [key] } — Sammel-
// Speichern der Einstellungskarte. Alle Werte werden VOR dem ersten Schreiben
// geprueft; ein ungueltiger Wert nennt seinen Key und laesst nichts halb
// gespeichert zurueck. `reset` setzt Keys auf den Registry-Default zurueck
// (auch Secrets: so wird ein Schluessel geloescht).
router.put('/', express.json(), (req, res) => {
  const body = req.body || {};
  const values = body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values : {};
  const reset = Array.isArray(body.reset) ? body.reset.map(String) : [];
  const updatedBy = sessionEmail(req);
  if ('auth.method' in values) {
    const code = _authMethodLockoutCode(values['auth.method'], updatedBy);
    if (code) return res.status(409).json({ error_code: code, key: 'auth.method' });
  }
  try {
    const r = appSettings.setMany(values, { reset, updatedBy });
    logger.info(`app-settings: ${r.written.length} gesetzt, ${r.reset.length} zurueckgesetzt (${[...r.written, ...r.reset].join(', ')})`, { user: updatedBy });
    res.json({ ok: true, written: r.written, reset: r.reset });
  } catch (e) {
    if (e.code === 'INVALID_VALUE' || e.code === 'UNKNOWN_KEY' || e.code === 'KEY_SET_AND_RESET') {
      logger.warn(`app-settings batch rejected: ${e.key}: ${e.reason || e.code}`, { user: updatedBy });
      return res.status(400).json({ error_code: e.code === 'INVALID_VALUE' ? 'INVALID_SETTING_VALUE' : e.code, key: e.key, params: { key: e.key } });
    }
    logger.error(`app-settings batch: ${e.message}`, { user: updatedBy });
    res.status(500).json({ error_code: 'PUT_FAILED' });
  }
});

router.get('/:key', (req, res) => {
  const items = appSettings.listForAdmin();
  const item = items.find(s => s.key === req.params.key);
  if (!item) return res.status(404).json({ error_code: 'KEY_NOT_FOUND' });
  res.json({ setting: item });
});

router.put('/:key', express.json(), (req, res) => {
  const { key } = req.params;
  const body = req.body || {};
  if (!('value' in body)) return res.status(400).json({ error_code: 'VALUE_REQUIRED' });
  if (!appSettings.isKnownKey(key)) return res.status(400).json({ error_code: 'UNKNOWN_KEY', key });
  const updatedBy = sessionEmail(req);
  if (key === 'auth.method') {
    const code = _authMethodLockoutCode(body.value, updatedBy);
    if (code) return res.status(409).json({ error_code: code, key });
  }
  try {
    const stored = appSettings.set(key, body.value, { updatedBy });
    logger.info(`app-settings: ${key} updated`, { user: updatedBy });
    res.json({ ok: true, key, value: appSettings.isEncryptedKey(key) ? '__masked__' : stored });
  } catch (e) {
    if (e.code === 'INVALID_VALUE') {
      logger.warn(`app-settings put ${key} rejected: ${e.reason}`, { user: updatedBy });
      return res.status(400).json({ error_code: 'INVALID_VALUE', key, reason: e.reason });
    }
    logger.error(`app-settings put ${key}: ${e.message}`, { user: updatedBy });
    res.status(500).json({ error_code: 'PUT_FAILED' });
  }
});

router.delete('/:key', (req, res) => {
  const { key } = req.params;
  appSettings.remove(key, { updatedBy: sessionEmail(req) });
  res.json({ ok: true, key, value: appSettings.get(key) });
});

// POST /admin/settings/test-provider { provider, values } — Probe des Providers,
// dessen Unter-Reiter der Admin gerade sieht, mit den Werten aus dem Formular
// (auch ungespeichert). `values` traegt nur Keys dieses Providers
// (`ai.<provider>.*`); ein unveraendertes Secret (`__unchanged__` bzw. leer)
// kommt aus app_settings — Secrets verlassen den Server nie. Claude: 1-Token-
// Completion; Ollama/OpenAI-kompatibel: Modell-Liste ueber lib/model-list.js
// (derselbe Client wie die Modell-Combobox). Fehler als Code (`error`), den
// das Frontend unter admin.settings.test.error.* uebersetzt.
const TEST_PROVIDERS = ['claude', 'ollama', 'openai-compat'];
router.post('/test-provider', express.json(), async (req, res) => {
  const body = req.body || {};
  const provider = TEST_PROVIDERS.includes(body.provider) ? body.provider : appSettings.get('ai.provider');
  if (!TEST_PROVIDERS.includes(provider)) return res.json({ ok: false, error: 'UNKNOWN_PROVIDER', provider });
  const formValues = body.values && typeof body.values === 'object' ? body.values : {};
  const val = (key) => {
    const v = Object.prototype.hasOwnProperty.call(formValues, key) && key.startsWith(`ai.${provider}.`)
      ? formValues[key] : undefined;
    if (appSettings.isEncryptedKey(key) && (v === undefined || v === '' || v === '__unchanged__')) return appSettings.get(key);
    return v === undefined ? appSettings.get(key) : v;
  };
  const t0 = Date.now();
  try {
    if (provider === 'claude') {
      const key = String(val('ai.claude.api_key') || '').trim();
      if (!key) return res.json({ ok: false, error: 'NO_API_KEY', provider });
      const model = String(val('ai.claude.model') || '').trim();
      const resp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      }, 15000);
      await resp.arrayBuffer().catch(() => {});
      const ok = resp.ok;
      return res.json({ ok, status: resp.status, provider, model, latency_ms: Date.now() - t0, ...(ok ? {} : { error: `HTTP_${resp.status}` }) });
    }
    const host = String(val(`ai.${provider}.host`) || '').trim();
    if (!host) return res.json({ ok: false, error: 'NO_HOST', provider });
    const r = await modelList.listModels(provider, {
      host,
      apiKey: provider === 'openai-compat' ? String(val('ai.openai-compat.api_key') || '').trim() : '',
    });
    return res.json({
      ok: !!r.ok, status: r.status || 0, provider, latency_ms: Date.now() - t0,
      ...(r.ok ? { model_count: r.models.length } : { error: r.error_code }),
    });
  } catch (e) {
    return res.json({ ok: false, provider, error: e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE', detail: e.message, latency_ms: Date.now() - t0 });
  }
});

// POST /admin/settings/test-oauth — Discovery-Doc-Fetch (kein voller
// OAuth-Roundtrip; nur Format-Check, dass Client-ID + Discovery-URL klappen).
router.post('/test-oauth', async (req, res) => {
  const clientId = appSettings.get('auth.google.client_id');
  if (!clientId) return res.json({ ok: false, error: 'NO_CLIENT_ID' });
  const t0 = Date.now();
  try {
    const r = await fetch('https://accounts.google.com/.well-known/openid-configuration');
    if (!r.ok) return res.json({ ok: false, status: r.status, latency_ms: Date.now() - t0 });
    const j = await r.json();
    return res.json({ ok: !!j.authorization_endpoint, latency_ms: Date.now() - t0 });
  } catch (e) {
    return res.json({ ok: false, error: 'UNREACHABLE', detail: e.message, latency_ms: Date.now() - t0 });
  }
});

// POST /admin/settings/test-languagetool — Health-Probe der konfigurierten
// LanguageTool-URL. Pingt /v2/languages (no-Body, billig); ok wenn 200.
router.post('/test-languagetool', async (req, res) => {
  const enabled = appSettings.get('languagetool.enabled') === true;
  const url = String(appSettings.get('languagetool.url') || '').replace(/\/$/, '').replace(/\/v2$/i, '');
  if (!url) return res.json({ ok: false, error: 'NO_URL' });
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${url}/v2/languages`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return res.json({ ok: false, status: r.status, latency_ms: Date.now() - t0, enabled });
    const j = await r.json().catch(() => null);
    const count = Array.isArray(j) ? j.length : 0;
    return res.json({ ok: true, status: r.status, latency_ms: Date.now() - t0, language_count: count, enabled });
  } catch (e) {
    return res.json({ ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE', detail: e.message, latency_ms: Date.now() - t0, enabled });
  }
});

// POST /admin/settings/test-stt — Health-Probe des konfigurierten Whisper-
// Hosts. Pingt /v1/models (billig, no-Body) mit optionalem Bearer; ok wenn 200.
router.post('/test-stt', async (req, res) => {
  const enabled = appSettings.get('stt.enabled') === true;
  const host = String(appSettings.get('stt.host') || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (!host) return res.json({ ok: false, error: 'NO_HOST', enabled });
  const apiKey = String(appSettings.get('stt.api_key') || '').trim();
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${host}/v1/models`, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    return res.json({ ok: !!r.ok, status: r.status, latency_ms: Date.now() - t0, enabled });
  } catch (e) {
    return res.json({ ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE', detail: e.message, latency_ms: Date.now() - t0, enabled });
  }
});

// POST /admin/settings/test-tts — Health-Probe des konfigurierten Speech-
// Hosts. Pingt /v1/models (billig, no-Body) mit optionalem Bearer; ok wenn 200.
router.post('/test-tts', async (req, res) => {
  const enabled = appSettings.get('tts.enabled') === true;
  const host = String(appSettings.get('tts.host') || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (!host) return res.json({ ok: false, error: 'NO_HOST', enabled });
  const apiKey = String(appSettings.get('tts.api_key') || '').trim();
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${host}/v1/models`, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    return res.json({ ok: !!r.ok, status: r.status, latency_ms: Date.now() - t0, enabled });
  } catch (e) {
    return res.json({ ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE', detail: e.message, latency_ms: Date.now() - t0, enabled });
  }
});

// POST /admin/settings/test-image — Health-Probe des konfigurierten Bild-
// Endpunkts. Pingt /v1/models (billig, no-Body) mit optionalem Bearer; ok wenn 200.
router.post('/test-image', async (req, res) => {
  const enabled = appSettings.get('image.enabled') === true;
  const host = String(appSettings.get('image.host') || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (!host) return res.json({ ok: false, error: 'NO_HOST', enabled });
  const apiKey = String(appSettings.get('image.api_key') || '').trim();
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${host}/v1/models`, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    return res.json({ ok: !!r.ok, status: r.status, latency_ms: Date.now() - t0, enabled });
  } catch (e) {
    return res.json({ ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE', detail: e.message, latency_ms: Date.now() - t0, enabled });
  }
});

// POST /admin/settings/test-embed — Health-Probe des Embedding-Endpunkts.
// Embeddet einen Mini-String und meldet die tatsächlich gelieferte Dimension
// (Sanity gegen die konfigurierte embed.dim). ok wenn ein Vektor zurückkommt.
router.post('/test-embed', async (req, res) => {
  const embed = require('../lib/embed');
  const enabled = appSettings.get('embed.enabled') === true;
  const { host, dim: cfgDim } = embed.getConfig();
  if (!host) return res.json({ ok: false, error: 'NO_HOST', enabled });
  const t0 = Date.now();
  try {
    // force: auch vor dem Einschalten testbar; ein Versuch mit dem Anfrage-Timeout
    // statt der Index-Retry-Kette (sonst hängt der Admin-Request minutenlang).
    const timeoutMs = parseInt(appSettings.get('embed.query_timeout_ms'), 10) || 30000;
    const vec = await embed.embedOne('Testsatz für die semantische Suche.', { force: true, retries: 0, timeoutMs });
    const dim = vec ? vec.length : 0;
    return res.json({ ok: dim > 0, dim, configured_dim: cfgDim, dim_mismatch: dim > 0 && dim !== cfgDim, latency_ms: Date.now() - t0, enabled });
  } catch (e) {
    return res.json({ ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE', detail: e.message, latency_ms: Date.now() - t0, enabled });
  }
});

// POST /admin/settings/test-rerank — Health-Probe des Reranker-Endpunkts.
// Rerankt zwei Mini-Dokumente gegen eine Anfrage und meldet, ob eine sortierte
// Score-Liste zurückkommt. ok wenn >=1 Treffer.
router.post('/test-rerank', async (req, res) => {
  const rerank = require('../lib/rerank');
  const enabled = appSettings.get('rerank.enabled') === true;
  const { host } = rerank.getConfig();
  if (!host) return res.json({ ok: false, error: 'NO_HOST', enabled });
  const t0 = Date.now();
  try {
    const order = await rerank.rerank('Abschied am Bahnhof', [
      'Sie standen am Gleis und winkten dem Zug nach.',
      'Das Rezept braucht drei Eier und Mehl.',
    ], { probe: true });
    const ok = Array.isArray(order) && order.length > 0;
    return res.json({ ok, count: order.length, latency_ms: Date.now() - t0, enabled });
  } catch (e) {
    return res.json({ ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE', detail: e.message, latency_ms: Date.now() - t0, enabled });
  }
});

// POST /admin/settings/test-geocode — Health-Probe der konfigurierten
// Geocoding-Quelle. Fragt eine bekannte Stadt ab; ok wenn >=1 Treffer.
router.post('/test-geocode', async (req, res) => {
  const provider = appSettings.get('geocode.provider') === 'photon' ? 'photon' : 'nominatim';
  const t0 = Date.now();
  try {
    let url;
    if (provider === 'photon') {
      const base = String(appSettings.get('geocode.photon.url') || '')
        .replace(/\/+$/, '')
        .replace(/\/api$/i, '');
      if (!base) return res.json({ ok: false, error: 'NO_URL', provider });
      url = `${base}/api?q=Z%C3%BCrich&limit=1&lang=de`;
    } else {
      const base = String(appSettings.get('geocode.nominatim.url') || 'https://nominatim.openstreetmap.org/search');
      url = `${base}?q=Z%C3%BCrich&format=jsonv2&limit=1`;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Schreibwerkstatt/1.0 (self-hosted book tool)', 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return res.json({ ok: false, status: r.status, provider, latency_ms: Date.now() - t0 });
    const j = await r.json().catch(() => null);
    const count = provider === 'photon'
      ? (Array.isArray(j?.features) ? j.features.length : 0)
      : (Array.isArray(j) ? j.length : 0);
    return res.json({ ok: count > 0, status: r.status, provider, result_count: count, latency_ms: Date.now() - t0 });
  } catch (e) {
    return res.json({ ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE', detail: e.message, provider, latency_ms: Date.now() - t0 });
  }
});

// POST /admin/settings/test-websearch — Probe-Suche gegen die konfigurierte
// SearXNG-Instanz über denselben Client wie die Werkzeuge (Timeout, Dedup).
// ok wenn >=1 Treffer; meldet zusätzlich Engines ohne Antwort (Rate-Limit,
// Captcha), damit der Admin eine halb taube Instanz erkennt.
router.post('/test-websearch', async (req, res) => {
  if (!searxng.isConfigured()) return res.json({ ok: false, error: 'NO_URL' });
  const t0 = Date.now();
  try {
    const { results, unresponsive } = await searxng.search('Matterhorn', { maxResults: 20 });
    return res.json({ ok: results.length > 0, result_count: results.length, unresponsive, latency_ms: Date.now() - t0 });
  } catch (e) {
    const timeout = e.cause?.code === 'WEBSEARCH_TIMEOUT';
    return res.json({ ok: false, error: timeout ? 'TIMEOUT' : 'UNREACHABLE', detail: e.message, latency_ms: Date.now() - t0 });
  }
});

// POST /admin/settings/test-tiles — Health-Probe des konfigurierten Tile-Servers.
// Laedt die Welt-Kachel z/x/y = 0/0/0 (existiert auf jedem OSM-kompatiblen
// Server) und prueft Status + image/*-Content-Type. {s}/{r} (Subdomain/Retina)
// werden auf konkrete Werte ersetzt.
router.post('/test-tiles', async (req, res) => {
  const tmpl = String(appSettings.get('geocode.tiles.url') || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
  const url = tmpl
    .replace(/\{s\}/g, 'a').replace(/\{r\}/g, '')
    .replace(/\{z\}/g, '0').replace(/\{x\}/g, '0').replace(/\{y\}/g, '0');
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Schreibwerkstatt/1.0 (self-hosted book tool)' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    await r.arrayBuffer().catch(() => {}); // Body draenen → Socket freigeben
    const ctype = r.headers.get('content-type') || '';
    const latency_ms = Date.now() - t0;
    if (!r.ok) return res.json({ ok: false, error: `HTTP_${r.status}`, status: r.status, latency_ms });
    if (!ctype.startsWith('image/')) return res.json({ ok: false, error: 'NOT_IMAGE', content_type: ctype, latency_ms });
    return res.json({ ok: true, status: r.status, content_type: ctype, latency_ms });
  } catch (e) {
    return res.json({ ok: false, error: e.name === 'AbortError' ? 'TIMEOUT' : 'UNREACHABLE', detail: e.message, latency_ms: Date.now() - t0 });
  }
});

// POST /admin/settings/models { target, host? } — Modell-Liste des zum Target
// gehoerenden Hosts (Anthropic /v1/models, Ollama /api/tags, sonst
// OpenAI-kompatibles /v1/models). Fuellt die Modell-Combobox in den
// Settings-Feldern; `host` uebersteuert den gespeicherten Wert, damit ein
// gerade eingetippter, noch nicht gespeicherter Host schon abgefragt werden
// kann (Schluessel kommt immer aus app_settings — Secrets verlassen den
// Server nie und kommen daher auch nicht zurueck).
// Unerreichbarer Host ist kein Fehler der Route: 200 mit ok:false.
router.post('/models', express.json(), async (req, res) => {
  const target = String(req.body?.target || '');
  if (!modelList.isKnownTarget(target)) {
    return res.status(400).json({ error_code: 'UNKNOWN_TARGET', target });
  }
  const host = String(req.body?.host || '').slice(0, 500);
  const t0 = Date.now();
  const r = await modelList.listModels(target, { host });
  return res.json({ ...r, target, latency_ms: Date.now() - t0 });
});

// POST /admin/settings/smtp/test-send { to? } — sendet ein 'test'-Template
// an `to` (Default: Gmail-User des Mailers). Liefert { ok, latencyMs, error? }.
router.post('/smtp/test-send', express.json(), async (req, res) => {
  const mailer = require('../lib/mailer');
  const status = mailer.getStatus();
  const to = (req.body?.to || status.fromEmail || '').trim();
  if (!to) return res.json({ ok: false, error: 'NO_RECIPIENT' });
  if (!status.ready) {
    return res.json({ ok: false, error: 'INCOMPLETE_CONFIG', missing: status.missing });
  }
  const r = await mailer.send({
    to,
    template: 'test',
    ctx: { mode: status.mode, fromEmail: status.fromEmail },
    locale: 'de',
  });
  if (r.sent) {
    logger.info(`smtp/test-send: ok to=${to} latency=${r.latencyMs}ms`, { user: sessionEmail(req) });
    return res.json({ ok: true, latency_ms: r.latencyMs });
  }
  return res.json({ ok: false, error: r.reason, missing: r.missing, detail: r.error });
});

module.exports = router;
