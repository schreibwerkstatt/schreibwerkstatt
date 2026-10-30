'use strict';
// Integration: weggeklickte Feature-Tipps (Alpine.store('hints')) in
// app_users.onboarding_state.hints über PATCH /me/onboarding { dismissHint }.
// Pro User, idempotent, Key-Format geprüft, bestehende Onboarding-Felder bleiben.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const A = 'hints-a@test.dev';
const B = 'hints-b@test.dev';

let ctx; let server; let baseUrl;

test.before(async () => {
  ctx = bootstrap();
  const appUsers = require('../../db/app-users');
  for (const email of [A, B]) if (!appUsers.getUser(email)) appUsers.createUser({ email });
  const router = require('../../routes/usersettings');
  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.headers['x-test-user'] } }; next(); });
  app.use('/me', router);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

async function call(method, body, user = A) {
  const res = await fetch(`${baseUrl}/me/onboarding`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test('ohne weggeklickte Tipps: leere Liste', async () => {
  const r = await call('GET');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.state.hints, []);
});

test('Tipp wegklicken: persistiert, idempotent, andere Felder bleiben', async () => {
  await call('PATCH', { welcomeDismissed: true });
  let r = await call('PATCH', { dismissHint: 'ideenBoard.erledigtCheck' });
  assert.equal(r.status, 200);
  r = await call('PATCH', { dismissHint: 'overview.bookChat.42' });
  r = await call('PATCH', { dismissHint: 'ideenBoard.erledigtCheck' });
  const g = await call('GET');
  assert.deepEqual(g.body.state.hints, ['overview.bookChat.42', 'ideenBoard.erledigtCheck']);
  assert.equal(g.body.state.welcomeDismissed, true);
});

test('Tipps sind pro User', async () => {
  const r = await call('GET', null, B);
  assert.deepEqual(r.body.state.hints, []);
});

test('ungültiger Key → 400, nichts gespeichert', async () => {
  for (const bad of ['', 'mit leerzeichen', 42, 'x'.repeat(200), '<script>']) {
    const r = await call('PATCH', { dismissHint: bad }, B);
    assert.equal(r.status, 400, String(bad));
  }
  const g = await call('GET', null, B);
  assert.deepEqual(g.body.state.hints, []);
});
