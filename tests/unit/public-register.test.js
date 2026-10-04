'use strict';
// Public-Landing + POST /register. User-Enumeration-Antwortgleichheit +
// Rate-Limit + Captcha-
// Skip bei Nicht-Konfiguration.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const { useTmpDb } = require('./_helpers/tmp-db');
const tmpDb = useTmpDb('public-register');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-crypto-derive';
delete process.env.LOCAL_DEV_MODE;

require('../../db/migrations');
const { db } = require('../../db/connection');
const regRequests = require('../../db/registration-requests');
const rateLimit = require('../../lib/register-ratelimit');

const express = require('express');
const publicRouter = require('../../routes/public');

const app = express();
// Stub session like server.js — unauth path is the one we test here.
app.use((req, res, next) => { req.session = {}; next(); });
app.use(publicRouter);

const server = app.listen(0);
const port = server.address().port;

test.before(() => { rateLimit._resetAll(); });
test.after(() => {
  server.close();
});

function _req(method, urlPath, { body = null, headers: extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', ...extra };
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: json, raw: buf, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('GET /landing -> HTML mit Login/Register-Buttons', async () => {
  const r = await _req('GET', '/landing');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'] || '', /html/);
  assert.match(r.raw, /href="\/login"/);
  assert.match(r.raw, /href="\/register"/);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('GET /register -> HTML mit Formular', async () => {
  const r = await _req('GET', '/register');
  assert.equal(r.status, 200);
  assert.match(r.raw, /name="email"/);
  assert.match(r.raw, /name="message"/);
});

test('GET / unauth -> landing.html ohne 401-Bounce', async () => {
  const r = await _req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.raw, /Schreibwerkstatt/);
});

test('POST /register mit gueltiger Email -> 202 + DB-Row', async () => {
  rateLimit._resetAll();
  const r = await _req('POST', '/register', { body: { email: 'newuser@example.com', message: 'pls' } });
  assert.equal(r.status, 202);
  assert.equal(r.body.ok, true);
  const row = regRequests.listPending().find(x => x.email === 'newuser@example.com');
  assert.ok(row, 'pending registration_request angelegt');
  assert.equal(row.message, 'pls');
});

test('GET /landing mit fremdem Referer reicht Herkunft an den Register-Link weiter', async () => {
  const r = await _req('GET', '/landing', { headers: { referer: 'https://www.google.com/search?q=x' } });
  assert.equal(r.status, 200);
  assert.match(r.raw, /href="\/register\?src=https%3A%2F%2Fwww\.google\.com%2Fsearch"/);
  const own = await _req('GET', '/landing', { headers: { referer: `http://127.0.0.1:${port}/` } });
  assert.match(own.raw, /href="\/register"/, 'eigener Host ist keine Herkunft');
});

test('GET /register übernimmt Kampagnen-Parameter in die Formular-Config', async () => {
  const r = await _req('GET', '/register?utm_source=newsletter');
  const cfg = JSON.parse(r.raw.match(/id="register-config">([^<]*)</)[1]);
  assert.equal(cfg.source, 'utm_source=newsletter');
  assert.match(r.raw, /name="sourceNote"/);
});

test('POST /register speichert Herkunft und Selbstauskunft', async () => {
  rateLimit._resetAll();
  const r = await _req('POST', '/register', {
    body: { email: 'origin@example.com', source: 'ref=mastodon', sourceNote: '  Podcast\n' },
  });
  assert.equal(r.status, 202);
  const row = regRequests.listPending().find(x => x.email === 'origin@example.com');
  assert.equal(row.source, 'ref=mastodon');
  assert.equal(row.source_note, 'Podcast');
});

test('POST /register Duplikat-Email -> 202 (kein User-Enumeration-Leak)', async () => {
  rateLimit._resetAll();
  const r = await _req('POST', '/register', { body: { email: 'newuser@example.com' } });
  // pending existiert bereits -> Insert wirft, Route schluckt -> immer 202
  assert.equal(r.status, 202);
  assert.equal(r.body.ok, true);
});

test('POST /register mit invalider Email -> 400 EMAIL_INVALID', async () => {
  rateLimit._resetAll();
  const r = await _req('POST', '/register', { body: { email: 'not-an-email' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error_code, 'EMAIL_INVALID');
});

test('POST /register Rate-Limit: 3 erfolgreiche Calls, 4. -> 429', async () => {
  rateLimit._resetAll();
  for (let i = 0; i < 3; i++) {
    const r = await _req('POST', '/register', { body: { email: `rl${i}@example.com` } });
    assert.ok(r.status === 202, `call ${i} unerwartet ${r.status}`);
  }
  const blocked = await _req('POST', '/register', { body: { email: 'rl3@example.com' } });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error_code, 'RATE_LIMITED');
  assert.ok(blocked.body.retryAfter > 0);
});
