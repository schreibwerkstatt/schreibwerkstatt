'use strict';
// Integration: /metrics + /metrics.json über HTTP (routes/metrics.js) und das
// Ausstellen eines Tokens mit Scope `metrics:users` (routes/admin-api-tokens.js).
//  - Ohne Bearer 401 BEARER_REQUIRED, nie Redirect.
//  - Pro-User-Kennzahlen nur mit `metrics:users`, in beiden Formaten.
//  - include_users beim Ausstellen setzt den Scope und schreibt `usage-viewed` ins Audit.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const ADMIN = 'admin@test.dev';

let ctx; let db; let server; let baseUrl; let apiTokens;

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  apiTokens = require('../../db/api-tokens');
  const NOW = new Date().toISOString();
  db.prepare(`INSERT INTO app_users (email, display_name, status, global_role, created_at)
              VALUES (?, 'Admin', 'active', 'admin', ?)`).run(ADMIN, NOW);

  const app = express();
  app.use((req, _res, next) => {
    const u = req.get('x-user');
    req.session = u ? { user: { email: u } } : {};
    next();
  });
  app.use(require('../../routes/metrics'));
  app.use('/admin/api-tokens', require('../../routes/admin-api-tokens'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

const get = (path, token) =>
  fetch(baseUrl + path, { headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: 'manual' });

test('Ohne Bearer: 401 BEARER_REQUIRED auf beiden Endpunkten', async () => {
  for (const p of ['/metrics', '/metrics.json']) {
    const res = await get(p);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') || '', /^Bearer/);
    assert.equal((await res.json()).error_code, 'BEARER_REQUIRED');
  }
});

test('metrics:read: Summen ja, Pro-User-Werte nein', async () => {
  const { plain_token } = apiTokens.createApiToken({ adminEmail: ADMIN, displayName: 'HA' });
  const text = await (await get('/metrics', plain_token)).text();
  assert.match(text, /^sw_books 0$/m);
  assert.doesNotMatch(text, /sw_user_/);
  const res = await get('/metrics.json', plain_token);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const j = await res.json();
  assert.equal(j.schema, 1);
  assert.equal(j.includes_users, false);
  assert.ok(!j.metrics.some(m => m.per_user));
});

test('include_users: Scope gesetzt, Audit geschrieben, Pro-User-Werte geliefert', async () => {
  const res = await fetch(baseUrl + '/admin/api-tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user': ADMIN },
    body: JSON.stringify({ display_name: 'HA voll', include_users: true }),
  });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.scopes, 'metrics:read,metrics:users');
  const audit = db.prepare(`SELECT meta_json FROM user_sessions_audit
                             WHERE user_email = ? AND event = 'usage-viewed'`).get(ADMIN);
  assert.ok(audit, 'Audit-Eintrag fehlt');
  assert.deepEqual(JSON.parse(audit.meta_json), { kind: 'metrics-users-token', tokenId: created.id, name: 'HA voll' });

  const j = await (await get('/metrics.json', created.plain_token)).json();
  assert.equal(j.includes_users, true);
  const seen = j.metrics.find(m => m.name === 'sw_user_writing_seconds_today');
  assert.ok(seen?.samples.some(s => s.labels.user === ADMIN));
  assert.match(await (await get('/metrics', created.plain_token)).text(), /^sw_user_books\{user="admin@test.dev"/m);
});
