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

// Etappe «Ersten Abschnitt lektorieren»: erledigt, sobald der User einen
// Lektorat-Lauf abgeschlossen hat (Zeile in page_checks mit seiner E-Mail) —
// Lauf eines anderen Users zählt nicht, Figuren/Schauplätze (Komplettanalyse)
// ebenso wenig.
test('Schritt lektorat folgt page_checks des Users, nicht fremden Läufen', async () => {
  const { db } = require('../../db/connection');
  let r = await call('GET', null, B);
  assert.equal(r.body.steps.lektorat, false);
  assert.equal('analysis' in r.body.steps, false);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(7101, 'Onboarding-Buch', now, now, A);
  db.prepare('INSERT INTO pages (page_id, book_id, page_name, updated_at) VALUES (?, ?, ?, ?)')
    .run(7201, 7101, 'Abschnitt 1', now);
  db.prepare(`INSERT INTO page_checks (page_id, book_id, checked_at, error_count, errors_json, user_email)
              VALUES (?, ?, ?, 0, '[]', ?)`).run(7201, 7101, now, A);
  r = await call('GET', null, B);
  assert.equal(r.body.steps.lektorat, false, 'Lauf eines anderen Users zählt nicht');
  r = await call('GET', null, A);
  assert.equal(r.body.steps.lektorat, true);
});
