'use strict';
// /admin/registration-requests-Endpoints.
// Approve erzeugt user_invites-Row + setzt status='approved'.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const { useTmpDb } = require('./_helpers/tmp-db');
const tmpDb = useTmpDb('admin-reg');
delete process.env.ADMIN_EMAIL;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const regRequests = require('../../db/registration-requests');

const express = require('express');
const adminReg = require('../../routes/admin-registration-requests');

const app = express();
app.use((req, res, next) => {
  const email = req.headers['x-test-user-email'];
  if (email) {
    req.session = { user: { email, name: email, role: req.headers['x-test-user-role'] || 'user' } };
  } else {
    req.session = {};
  }
  next();
});
app.use('/admin/registration-requests', adminReg);

const server = app.listen(0);
const port = server.address().port;

test.after(() => {
  server.close();
});

// Seed: admin + pending requests
appUsers.createUser({ email: 'admin@example.com', displayName: 'Admin', globalRole: 'admin' });
appUsers.createUser({ email: 'bob@example.com',   displayName: 'Bob',   globalRole: 'user' });
const reqAlice = regRequests.createRequest({ email: 'alice@example.com', displayName: 'Alice', message: 'hi' });
const reqEve   = regRequests.createRequest({ email: 'eve@example.com',   displayName: 'Eve' });

function _req(method, urlPath, { user = null, role = 'user', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (user) {
      headers['x-test-user-email'] = user;
      headers['x-test-user-role'] = role;
    }
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, body: json, raw: buf });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

test('GET /admin/registration-requests ohne Login -> 401', async () => {
  const r = await _req('GET', '/admin/registration-requests');
  assert.equal(r.status, 401);
});

test('GET /admin/registration-requests als User -> 403', async () => {
  const r = await _req('GET', '/admin/registration-requests', { user: 'bob@example.com' });
  assert.equal(r.status, 403);
});

test('GET /admin/registration-requests als Admin -> 200 + pending-Liste', async () => {
  const r = await _req('GET', '/admin/registration-requests', { user: 'admin@example.com', role: 'admin' });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.items));
  const emails = r.body.items.map(i => i.email);
  assert.ok(emails.includes('alice@example.com'));
  assert.ok(emails.includes('eve@example.com'));
});

test('POST /:id/approve erzeugt invite + setzt status=approved', async () => {
  const r = await _req('POST', `/admin/registration-requests/${reqAlice.id}/approve`,
    { user: 'admin@example.com', role: 'admin', body: { role: 'user' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.request.status, 'approved');
  assert.ok(r.body.invite.invite_token);
  assert.match(r.body.inviteUrl, /\/invite\//);
  const updated = regRequests.getRequest(reqAlice.id);
  assert.equal(updated.status, 'approved');
  assert.equal(updated.invite_id, r.body.invite.id);
});

test('POST /:id/approve auf bereits behandelte Request -> 409', async () => {
  const r = await _req('POST', `/admin/registration-requests/${reqAlice.id}/approve`,
    { user: 'admin@example.com', role: 'admin', body: { role: 'user' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error_code, 'REQUEST_NOT_PENDING');
});

test('POST /:id/deny mit reason setzt status=denied', async () => {
  const r = await _req('POST', `/admin/registration-requests/${reqEve.id}/deny`,
    { user: 'admin@example.com', role: 'admin', body: { reason: 'spam' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.request.status, 'denied');
  assert.equal(r.body.request.review_reason, 'spam');
});

test('POST /expire-stale liefert {expired,days}', async () => {
  regRequests.createRequest({ email: 'old@example.com' });
  db.prepare(`UPDATE registration_requests SET created_at = datetime('now','-40 days') WHERE email = 'old@example.com'`).run();
  const r = await _req('POST', '/admin/registration-requests/expire-stale',
    { user: 'admin@example.com', role: 'admin' });
  assert.equal(r.status, 200);
  assert.ok(r.body.expired >= 1);
  assert.equal(r.body.days, 30);
});

test('GET ?status=denied liefert nur denied', async () => {
  const r = await _req('GET', '/admin/registration-requests?status=denied',
    { user: 'admin@example.com', role: 'admin' });
  assert.equal(r.status, 200);
  assert.ok(r.body.items.every(i => i.status === 'denied'));
});

// Approve/Deny warten die Mail ab: die Antwort traegt das echte Versand-Ergebnis
// statt immer 'not-attempted' (das UI zeigte sonst stets «Mailer deaktiviert»).
test('POST /:id/approve + /deny: Mail-Ergebnis wird abgewartet', async () => {
  const mailer = require('../../lib/mailer');
  const orig = mailer.send;
  const sent = [];
  mailer.send = async (opts) => {
    await new Promise(r => setTimeout(r, 20));
    sent.push(opts.template);
    return { sent: true, latencyMs: 20 };
  };
  try {
    const a = regRequests.createRequest({ email: 'mail-approve@example.com', displayName: 'MA' });
    const d = regRequests.createRequest({ email: 'mail-deny@example.com', displayName: 'MD' });
    let r = await _req('POST', `/admin/registration-requests/${a.id}/approve`, {
      user: 'admin@example.com', role: 'admin', body: { role: 'user' },
    });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.mail.sent, true);
    r = await _req('POST', `/admin/registration-requests/${d.id}/deny`, {
      user: 'admin@example.com', role: 'admin', body: { reason: 'nein' },
    });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.mail.sent, true);
    assert.deepEqual(sent, ['registration-approved', 'registration-denied']);
  } finally {
    mailer.send = orig;
  }
});
