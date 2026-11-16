'use strict';
// Eigener KI-Zugang im Profil: ein Konto hinterlegt seinen eigenen API-Zugang
// (Claude oder OpenAI-kompatibel) und faehrt damit alle KI-Calls auf eigene Kosten.
// Gespeichert als KI-Profil mit `owner_email` (db/ai-profiles.js) — dadurch laufen
// Cache-Trennung, Semaphore-Bucket und Key-Aufloesung ueber dieselbe Mechanik wie
// bei Admin-Profilen (lib/ai/profile.js).
//
// Freigabe durch den Admin: `ai.user_api.enabled`. Zu → GET meldet `enabled:false`,
// Schreiben antwortet 403; ein gespeicherter Zugang bleibt liegen, greift aber nicht.
//
// Sicherheits-Invarianten (Durchsetzung in lib/ai/profile.js + lib/ai/openai-compat.js):
//   - der Host eines eigenen Zugangs ist User-Eingabe → SSRF-Guard beim Speichern
//     (assertPublicUrl, frueh lesbar) UND bei jedem Call (safeFetch)
//   - ein eigener Zugang faellt nie auf Host oder Key der Instanz zurueck
//   - der Key geht nie zurueck an den Client (`has_api_key`)

const express = require('express');
const aiProfiles = require('../db/ai-profiles');
const appUsers = require('../db/app-users');
const appSettings = require('../lib/app-settings');
const { sessionEmail } = require('../lib/acl');
const { contextSafetyMargin } = require('../lib/ai');
const { assertPublicUrl } = require('../lib/ssrf-guard');
const { ownUsageByType } = require('../db/cost-ledger');
const { localMonthStartIso, localMonthPeriod } = require('../lib/local-date');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

const OWN_PROVIDERS = new Set(['claude', 'openai-compat']);

function _enabled() {
  return appSettings.get('ai.user_api.enabled') === true;
}

// Antwortform: nur, was die Profil-Seite braucht — kein Key, keine Interna.
function _view(prof) {
  if (!prof) return null;
  return {
    provider: prof.provider,
    model: prof.model,
    host: prof.host,
    has_api_key: !!prof.has_api_key,
    cloud: prof.cloud,
    context_window: prof.context_window,
    max_tokens_out: prof.max_tokens_out,
    updated_at: prof.updated_at,
  };
}

function _optInt(v, min, max) {
  if (v === null || v === undefined || v === '' || v === 0 || v === '0') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) return { ok: false };
  return { ok: true, value: n };
}

function _text(v, max) {
  const s = String(v ?? '').trim();
  return s.length > max ? null : s;
}

// Validierung + Normalisierung. Rueckgabe `{ error_code, detail? }` oder `{ data }`.
async function _validate(body, prev) {
  const provider = String(body.provider || '').toLowerCase();
  if (!OWN_PROVIDERS.has(provider)) return { error_code: 'AI_ACCESS_PROVIDER_INVALID' };

  const model = _text(body.model, 120);
  if (model === null) return { error_code: 'AI_ACCESS_MODEL_INVALID' };

  // Key: '__unchanged__' behaelt den gespeicherten — aber nur, wenn es einen gibt
  // und der Provider gleich bleibt (ein Claude-Key ist kein OpenAI-Key).
  let apiKey = body.api_key;
  const keepKey = apiKey === '__unchanged__' && !!(prev && prev.has_api_key && prev.provider === provider);
  if (!keepKey) {
    apiKey = apiKey === '__unchanged__' ? '' : _text(apiKey, 500);
    if (apiKey === null) return { error_code: 'AI_ACCESS_KEY_INVALID' };
  }
  const hasKey = keepKey || !!apiKey;

  let host = null;
  if (provider === 'claude') {
    if (!hasKey) return { error_code: 'AI_ACCESS_KEY_REQUIRED' };
  } else {
    host = _text(body.host, 500);
    if (!host) return { error_code: 'AI_ACCESS_HOST_REQUIRED' };
    host = host.replace(/\/+$/, '').replace(/\/v1$/, '');
    try { await assertPublicUrl(host); }
    catch { return { error_code: 'AI_ACCESS_HOST_BLOCKED' }; }
    if (!model) return { error_code: 'AI_ACCESS_MODEL_REQUIRED' };
  }

  const ctx = _optInt(body.context_window, 2048, 2000000);
  const out = _optInt(body.max_tokens_out, 512, 200000);
  if (!ctx.ok || !out.ok) return { error_code: 'AI_ACCESS_WINDOW_INVALID' };
  if (ctx.value && out.value && out.value + contextSafetyMargin(ctx.value) >= ctx.value) {
    return { error_code: 'AI_ACCESS_WINDOW_INVALID' };
  }

  // Claude-Zugang = nur der Key; Modell und Fenster kommen von der Instanz.
  const claude = provider === 'claude';
  return {
    data: {
      provider,
      model: claude ? null : (model || null),
      host,
      api_key: keepKey ? '__unchanged__' : (apiKey || null),
      // Claude ist immer Klasse 'cloud'; bei OpenAI-kompatibel waehlt der User.
      cloud: provider === 'openai-compat' ? body.cloud === true : null,
      context_window: claude ? null : ctx.value,
      max_tokens_out: claude ? null : out.value,
    },
  };
}

router.get('/', (req, res) => {
  const email = sessionEmail(req);
  // Zugedreht: `stored` sagt der Profil-Seite, dass noch ein Key liegt, den der
  // User entfernen kann.
  if (!_enabled()) return res.json({ enabled: false, access: null, stored: !!aiProfiles.getOwnProfile(email) });
  res.json({ enabled: true, access: _view(aiProfiles.getOwnProfile(email)) });
});

router.put('/', jsonBody, async (req, res) => {
  const email = sessionEmail(req);
  if (!_enabled()) return res.status(403).json({ error_code: 'AI_ACCESS_DISABLED' });
  const prev = aiProfiles.getOwnProfile(email);
  const v = await _validate(req.body || {}, prev);
  if (v.error_code) return res.status(400).json(v);
  const saved = aiProfiles.saveOwnProfile(email, v.data);
  // Audit-Spur ueber das bestehende Event: der effektive Provider des Kontos
  // wechselt; `own: true` unterscheidet es von der Admin-Zuweisung.
  appUsers.recordAuditEvent(email, 'ai-provider-changed', {
    ip: req.ip || null, userAgent: req.get('user-agent') || null,
    meta: { own: true, provider: saved.provider, model: saved.model || null, host: saved.host || null, by: email },
  });
  logger.info(`Eigener KI-Zugang gespeichert (${saved.provider}${saved.model ? ' ' + saved.model : ''}).`);
  res.json({ enabled: true, access: _view(saved) });
});

// Kosten ueber den eigenen Key: laufender und voriger Monat (App-Zeitzone), je
// Quelle x Typ. USD aus dem Ledger (lib/pricing.js, zur Call-Zeit eingefroren) —
// eine Schaetzung; verbindlich ist die Rechnung des Anbieters. Auch bei
// zugedrehtem Feature lesbar: es sind die eigenen Daten des Users.
function _monthUsage(email, fromIso, toIso, period) {
  const rows = ownUsageByType(email, fromIso, toIso).map(r => ({
    source: r.source, type: r.type || 'unknown', provider: r.provider,
    calls: r.calls, usd: r.usd || 0, tokensIn: r.tokens_in || 0, tokensOut: r.tokens_out || 0,
  }));
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  return { period, usd: sum('usd'), calls: sum('calls'), tokensIn: sum('tokensIn'), tokensOut: sum('tokensOut'), rows };
}

router.get('/usage', (req, res) => {
  const email = sessionEmail(req);
  const now = new Date();
  const thisStart = localMonthStartIso(now);
  // Ein Tag vor dem Monatsersten liegt sicher im Vormonat (auch ueber DST).
  const prevAnchor = new Date(Date.parse(thisStart) - 24 * 3600 * 1000);
  const prevStart = localMonthStartIso(prevAnchor);
  res.json({
    months: [
      _monthUsage(email, thisStart, now.toISOString(), localMonthPeriod(now)),
      _monthUsage(email, prevStart, thisStart, localMonthPeriod(prevAnchor)),
    ],
  });
});

// Entfernen ist auch bei zugedrehtem Feature erlaubt: der User soll seinen Key
// aus der Instanz nehmen koennen, egal was der Admin gerade eingestellt hat.
router.delete('/', (req, res) => {
  const email = sessionEmail(req);
  const removed = aiProfiles.deleteOwnProfile(email);
  if (removed) {
    appUsers.recordAuditEvent(email, 'ai-provider-changed', {
      ip: req.ip || null, userAgent: req.get('user-agent') || null,
      meta: { own: true, provider: null, by: email },
    });
    logger.info('Eigener KI-Zugang entfernt.');
  }
  res.json({ enabled: _enabled(), access: null, stored: false });
});

module.exports = router;
