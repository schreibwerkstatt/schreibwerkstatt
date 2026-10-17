// Auth-Guard (lib/auth-guard.js): ohne Anmeldung bekommt NUR eine
// Browser-Navigation den Redirect auf /login, jeder andere Request 401 JSON —
// unabhaengig vom Pfad. Frueher entschied eine Praefix-Liste, und ~20 gemountete
// Router (/ideen, /plot, /events, …) lieferten fetch() ein 302 auf Login-HTML
// statt des 401, an dem das zentrale session-expired-Handling haengt.
//
// Dazu die Fehlerkette (lib/async-routes.js): Rejections von async-Handlern
// landen beim finalen JSON-Fehler-Handler statt den Request haengen zu lassen.
//
// Lauf: `node --test tests/unit/auth-guard.test.mjs`
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
process.env.DB_PATH = path.join(os.tmpdir(), `auth-guard-test-${process.pid}-${Date.now()}.db`);
delete process.env.ADMIN_EMAIL;
require('../../db/migrations');

const express = require('express');
require('../../lib/async-routes').install();
const { errorHandler } = require('../../lib/async-routes');
const { makeAuthGuard, wantsLoginRedirect } = require('../../lib/auth-guard');
// Eine Sitzung gilt nur mit bestehendem, nicht gesperrtem Konto (Auth-Guard
// prueft app_users) — darum das Test-Konto anlegen.
const appUsers = require('../../db/app-users');
appUsers.createUser({ email: 'a@b.c', displayName: 'A' });

function makeApp({ user = null } = {}) {
  const app = express();
  app.use((req, _res, next) => { req.session = user ? { user } : {}; next(); });
  app.use(makeAuthGuard({ localDevMode: false }));
  app.get('/ideen/list', (_req, res) => res.json({ ok: true }));
  app.get('/boom', async () => { await Promise.resolve(); throw new Error('kaputt'); });
  const r = express.Router();
  r.param('id', async (_req, _res, next, id) => { await Promise.resolve(); if (id === 'bad') throw new Error('param'); next(); });
  r.get('/item/:id', (_req, res) => res.json({ ok: true }));
  app.use('/r', r);
  app.post('/json', express.json({ limit: '10b' }), (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

// Roh-HTTP statt fetch(): undici setzt `sec-fetch-mode: cors` selbst und
// ueberschreibt den Header — eine Navigation liesse sich damit nicht nachstellen.
const http = require('http');
function raw(base, pathname, { method = 'GET', headers = {} } = {}) {
  const u = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.close(); }
}

test('fetch() auf einen Nicht-Praefix-Router ohne Session → 401 JSON', async () => {
  await withServer(makeApp(), async (base) => {
    const res = await fetch(`${base}/ideen/list`, { redirect: 'manual', headers: { 'sec-fetch-mode': 'cors', accept: '*/*' } });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error_code: 'NOT_LOGGED_IN' });
  });
});

test('Browser-Navigation ohne Session → Redirect auf /login mit returnTo', async () => {
  await withServer(makeApp(), async (base) => {
    const res = await raw(base, '/ideen/list?x=1', {
      headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html,application/xhtml+xml' },
    });
    assert.equal(res.status, 302);
    assert.equal(res.location, `/login?returnTo=${encodeURIComponent('/ideen/list?x=1')}`);
  });
});

test('ohne Fetch-Metadata: Accept text/html → Redirect, */* → 401, POST → 401', async () => {
  await withServer(makeApp(), async (base) => {
    const html = await raw(base, '/ideen/list', { headers: { accept: 'text/html' } });
    assert.equal(html.status, 302);
    const any = await raw(base, '/ideen/list', { headers: { accept: '*/*' } });
    assert.equal(any.status, 401);
    const post = await raw(base, '/ideen/list', { method: 'POST', headers: { accept: 'text/html' } });
    assert.equal(post.status, 401);
  });
});

test('ungueltiges swd_-Device-Token → 401 JSON, auch mit Session', async () => {
  await withServer(makeApp({ user: { email: 'a@b.c' } }), async (base) => {
    const res = await fetch(`${base}/ideen/list`, { redirect: 'manual', headers: { authorization: 'Bearer swd_invalid' } });
    assert.equal(res.status, 401);
  });
});

test('wantsLoginRedirect: EventSource (text/event-stream) ist keine Navigation', () => {
  const req = { method: 'GET', headers: { 'sec-fetch-mode': 'cors', accept: 'text/event-stream' } };
  assert.equal(wantsLoginRedirect(req), false);
});

test('mit Session: async-Handler-Rejection → 500 INTERNAL statt Haenger', async () => {
  await withServer(makeApp({ user: { email: 'a@b.c' } }), async (base) => {
    const ok = await fetch(`${base}/ideen/list`);
    assert.equal(ok.status, 200);
    const boom = await fetch(`${base}/boom`, { signal: AbortSignal.timeout(3000) });
    assert.equal(boom.status, 500);
    assert.deepEqual(await boom.json(), { error_code: 'INTERNAL' });
  });
});

test('async router.param-Rejection erreicht den Fehler-Handler', async () => {
  await withServer(makeApp({ user: { email: 'a@b.c' } }), async (base) => {
    const bad = await fetch(`${base}/r/item/bad`, { signal: AbortSignal.timeout(3000) });
    assert.equal(bad.status, 500);
    const good = await fetch(`${base}/r/item/1`);
    assert.equal(good.status, 200);
  });
});

test('body-parser-Fehler behalten ihren 4xx-Status als JSON', async () => {
  await withServer(makeApp({ user: { email: 'a@b.c' } }), async (base) => {
    const big = await fetch(`${base}/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(100) }) });
    assert.equal(big.status, 413);
    assert.deepEqual(await big.json(), { error_code: 'PAYLOAD_TOO_LARGE' });
    const broken = await fetch(`${base}/json`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{x' });
    assert.equal(broken.status, 400);
    assert.deepEqual(await broken.json(), { error_code: 'INVALID_JSON' });
  });
});

test('Sitzung ohne app_users-Row (Konto geloescht) → 401, gesperrt ebenso', async () => {
  await withServer(makeApp({ user: { email: 'geist@b.c' } }), async (base) => {
    const res = await fetch(`${base}/ideen/list`, { redirect: 'manual', headers: { 'sec-fetch-mode': 'cors', accept: '*/*' } });
    assert.equal(res.status, 401);
  });
  appUsers.createUser({ email: 'gesperrt@b.c', displayName: 'G', status: 'suspended' });
  await withServer(makeApp({ user: { email: 'gesperrt@b.c' } }), async (base) => {
    const res = await fetch(`${base}/ideen/list`, { redirect: 'manual', headers: { 'sec-fetch-mode': 'cors', accept: '*/*' } });
    assert.equal(res.status, 401);
  });
});

test('ENV-Admin (Notfall-Zugang) bleibt angemeldet, auch gesperrt', async () => {
  appUsers.createUser({ email: 'notfall@b.c', displayName: 'N', status: 'suspended' });
  process.env.ADMIN_EMAIL = 'Notfall@B.c';
  try {
    await withServer(makeApp({ user: { email: 'notfall@b.c' } }), async (base) => {
      const res = await fetch(`${base}/ideen/list`, { redirect: 'manual', headers: { 'sec-fetch-mode': 'cors', accept: '*/*' } });
      assert.equal(res.status, 200);
    });
  } finally {
    delete process.env.ADMIN_EMAIL;
  }
});
