'use strict';
// Eigener KI-Zugang im Profil (routes/me-ai-access.js + lib/ai/profile.js):
// Admin-Schalter, Validierung inkl. SSRF-Guard, Vorrang vor Zuweisung und
// globalem Provider, kein Rueckfall auf Host/Key der Instanz. Claude-Zugang =
// nur eigener Key, Modell-Einstellungen von der Instanz; eigener Endpunkt =
// Job-Overrides der Instanz greifen nicht.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('own-ai-access');
// Reserved-TLD-Hosts ohne DNS; Literal-/localhost-Block bleibt aktiv.
process.env.SSRF_SKIP_DNS_CHECK = '1';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';

require('../../db/migrations').runMigrations();
const appUsers = require('../../db/app-users');
const aiProfiles = require('../../db/ai-profiles');
const appSettings = require('../../lib/app-settings');
const ai = require('../../lib/ai');
const { aiSetting, aiApiKey, usesOwnAccess } = require('../../lib/ai/profile');
const { jobOverride } = require('../../lib/ai/config');
const { runWithContext } = require('../../lib/log-context');

const express = require('express');
const app = express();
app.use((req, _res, next) => {
  const email = req.headers['x-test-user-email'];
  req.session = email ? { user: { email, name: email, role: 'user' } } : {};
  next();
});
app.use('/me/ai-access', require('../../routes/me-ai-access'));
const server = app.listen(0);
const port = server.address().port;
test.after(() => server.close());

const U = 'writer@example.com';
appUsers.createUser({ email: U, displayName: 'Writer' });

function req(method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port, path: '/me/ai-access', method,
      headers: { 'content-type': 'application/json', 'x-test-user-email': U },
    }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('Feature zu: GET meldet enabled:false, PUT antwortet 403', async () => {
  appSettings.set('ai.user_api.enabled', false);
  const g = await req('GET');
  assert.equal(g.status, 200);
  assert.equal(g.body.enabled, false);
  const p = await req('PUT', { provider: 'claude', api_key: 'sk-ant-x' });
  assert.equal(p.status, 403);
  assert.equal(p.body.error_code, 'AI_ACCESS_DISABLED');
});

test('Validierung: Claude braucht Key, OpenAI-kompatibel Host + Modell, private Hosts fallen', async () => {
  appSettings.set('ai.user_api.enabled', true);
  assert.equal((await req('PUT', { provider: 'ollama', api_key: 'x' })).body.error_code, 'AI_ACCESS_PROVIDER_INVALID');
  assert.equal((await req('PUT', { provider: 'claude' })).body.error_code, 'AI_ACCESS_KEY_REQUIRED');
  assert.equal((await req('PUT', { provider: 'openai-compat', model: 'm' })).body.error_code, 'AI_ACCESS_HOST_REQUIRED');
  for (const host of ['http://127.0.0.1:8080', 'http://localhost:11434', 'http://169.254.169.254', 'http://10.0.0.5']) {
    const r = await req('PUT', { provider: 'openai-compat', host, model: 'm' });
    assert.equal(r.body.error_code, 'AI_ACCESS_HOST_BLOCKED', host);
  }
  assert.equal((await req('PUT', { provider: 'openai-compat', host: 'https://api.example.test' })).body.error_code, 'AI_ACCESS_MODEL_REQUIRED');
  const bad = await req('PUT', { provider: 'claude', api_key: 'k', context_window: 8000, max_tokens_out: 8000 });
  assert.equal(bad.body.error_code, 'AI_ACCESS_WINDOW_INVALID');
});

test('Claude-Zugang: gewinnt ueber globalen Provider und Zuweisung, Key kommt nie zurueck', async () => {
  appSettings.set('ai.user_api.enabled', true);
  appSettings.set('ai.provider', 'ollama');
  const assigned = aiProfiles.createProfile({ name: 'Lokal', provider: 'openai-compat', host: 'http://10.0.0.9:8080' });
  appUsers.setAiProfile(U, assigned.id);

  const r = await req('PUT', { provider: 'claude', api_key: 'sk-ant-own' });
  assert.equal(r.status, 200);
  assert.equal(r.body.access.provider, 'claude');
  assert.equal(r.body.access.has_api_key, true);
  assert.ok(!JSON.stringify(r.body).includes('sk-ant-own'));

  assert.equal(ai.resolveProvider({ userEmail: U }), 'claude');
  assert.equal(aiApiKey('claude', { userEmail: U }), 'sk-ant-own');
  assert.equal(usesOwnAccess({ userEmail: U }), true);
  // Admin-Liste kennt den eigenen Zugang nicht.
  assert.ok(aiProfiles.listProfiles().every(p => !p.owner_email));

  // '__unchanged__' behaelt den Key beim selben Provider. Modell/Fenster eines
  // Claude-Zugangs werden nicht gespeichert: sie kommen von der Instanz.
  appSettings.set('ai.claude.model', 'claude-sonnet-5-5');
  const keep = await req('PUT', { provider: 'claude', api_key: '__unchanged__', model: 'claude-opus-5-5', context_window: 50000 });
  assert.equal(keep.status, 200);
  assert.equal(keep.body.access.model, null);
  assert.equal(keep.body.access.context_window, null);
  assert.equal(aiApiKey('claude', { userEmail: U }), 'sk-ant-own');
  assert.equal(aiSetting('claude', 'model', { userEmail: U }), 'claude-sonnet-5-5');
  // Auch ein Altbestand mit Modell in der Zeile folgt der Instanz.
  aiProfiles.updateProfile(aiProfiles.getOwnProfile(U).id, { model: 'claude-haiku-4-5' });
  assert.equal(aiSetting('claude', 'model', { userEmail: U }), 'claude-sonnet-5-5');

  // Feature zugedreht → zurueck auf die Zuweisung, Zugang bleibt liegen.
  appSettings.set('ai.user_api.enabled', false);
  assert.equal(ai.resolveProvider({ userEmail: U }), 'openai-compat');
  assert.equal((await req('GET')).body.stored, true);
  appSettings.set('ai.user_api.enabled', true);
  appUsers.setAiProfile(U, null);
});

test('OpenAI-kompatibel: kein Rueckfall auf Instanz-Key oder -Host', async () => {
  appSettings.set('ai.user_api.enabled', true);
  appSettings.set('ai.openai-compat.api_key', 'INSTANCE-SECRET');
  appSettings.set('ai.openai-compat.host', 'http://10.1.2.3:8080');

  // Provider-Wechsel mit '__unchanged__': der Claude-Key wandert NICHT mit.
  const r = await req('PUT', {
    provider: 'openai-compat', host: 'https://api.example.test/v1/', model: 'gpt-x', api_key: '__unchanged__', cloud: true,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.access.host, 'https://api.example.test');
  assert.equal(r.body.access.has_api_key, false);
  assert.equal(aiApiKey('openai-compat', { userEmail: U }), '');
  assert.equal(aiSetting('openai-compat', 'host', { userEmail: U }), 'https://api.example.test');
  assert.equal(ai.providerClass('openai-compat', { userEmail: U }), 'cloud');

  // Fehlt der Host in der Zeile, erbt er trotzdem nicht den internen Instanz-Host.
  const own = aiProfiles.getOwnProfile(U);
  aiProfiles.updateProfile(own.id, { host: null });
  assert.equal(aiSetting('openai-compat', 'host', { userEmail: U }), null);
});

test('Eigener Claude-Zugang: Job-Overrides und Tier der Instanz gelten wie ohne eigenen Key', async () => {
  appSettings.set('ai.user_api.enabled', true);
  await req('PUT', { provider: 'claude', api_key: 'sk-ant-own' });
  const bag = { provider: 'claude', model: 'claude-opus-4-8', contextWindow: 1000000, effort: 'high', timeoutMs: 1234 };
  runWithContext({ user: U, aiJob: bag }, () => {
    assert.equal(jobOverride('claude', 'model'), 'claude-opus-4-8');
    assert.equal(jobOverride('claude', 'contextWindow'), 1000000);
    assert.equal(jobOverride('claude', 'effort'), 'high');
    assert.equal(jobOverride('claude', 'timeoutMs'), 1234);
    assert.equal(ai._resolveClaudeModel('claude-haiku-tier'), 'claude-haiku-tier');
  });
});

test('Eigener OpenAI-kompatibler Endpunkt: Job-Overrides der Instanz greifen nicht (ausser Timeout)', async () => {
  appSettings.set('ai.user_api.enabled', true);
  await req('PUT', { provider: 'openai-compat', host: 'https://api.example.test', model: 'gpt-x', api_key: 'k', cloud: true });
  const bag = { provider: 'openai-compat', model: 'qwen-instanz', contextWindow: 262000, timeoutMs: 1234 };
  runWithContext({ user: U, aiJob: bag }, () => {
    assert.equal(jobOverride('openai-compat', 'model'), undefined);
    assert.equal(jobOverride('openai-compat', 'contextWindow'), undefined);
    assert.equal(jobOverride('openai-compat', 'timeoutMs'), 1234);
  });
});

test('Entfernen: auch bei zugedrehtem Feature; danach globaler Provider', async () => {
  appSettings.set('ai.user_api.enabled', false);
  const d = await req('DELETE');
  assert.equal(d.status, 200);
  assert.equal(aiProfiles.getOwnProfile(U), null);
  appSettings.set('ai.user_api.enabled', true);
  assert.equal(ai.resolveProvider({ userEmail: U }), 'ollama');
});
