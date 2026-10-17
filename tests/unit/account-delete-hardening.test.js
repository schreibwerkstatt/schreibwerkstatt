'use strict';
// Konto-Selbstloeschung, die zwei Luecken neben dem Grundvertrag
// (tests/unit/account-delete.test.js):
//   1. Andere Login-Sitzungen desselben Kontos muessen mit dem Konto fallen —
//      im Session-Store UND am Auth-Guard (eine laufende Anfrage kann ihre
//      Sitzung nach dem DELETE noch zurueckschreiben).
//   2. Laesst sich ein eigenes Buch nicht loeschen, darf das Konto nicht fallen:
//      sonst haengt das Manuskript ohne book_access-Owner im Nirgendwo.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('account-delete-hardening');
delete process.env.ADMIN_EMAIL;
delete process.env.DEMO_EMAIL;
delete process.env.DEMO_PASSWORD;

require('../../db/migrations');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const bookAccess = require('../../db/book-access');
const contentStore = require('../../lib/content-store');
const accountDelete = require('../../lib/account-delete');
const { makeAuthGuard } = require('../../lib/auth-guard');

const express = require('express');
const userSettingsRouter = require('../../routes/usersettings');

// Dieselbe Tabelle, die better-sqlite3-session-store in server.js anlegt.
db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT NOT NULL PRIMARY KEY, sess JSON NOT NULL, expire TEXT NOT NULL
)`).run();
function storeSession(sid, email) {
  const sess = { cookie: { maxAge: 1000 }, user: { email, name: email, role: 'user' } };
  db.prepare('INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)')
    .run(sid, JSON.stringify(sess), new Date(Date.now() + 86400000).toISOString());
}
const sessionCount = (sid) => db.prepare('SELECT COUNT(*) c FROM sessions WHERE sid = ?').get(sid).c;

async function seedBook(email, name) {
  const ctx = { session: { user: { email } } };
  const book = await contentStore.createBook({ name, owner_email: email }, ctx);
  bookAccess.grantAccess(book.id, email, 'owner', email);
  return book.id;
}

// Mini-App: Session-Attrappe aus Header, davor der echte Auth-Guard.
const app = express();
app.use((req, _res, next) => {
  const email = req.headers['x-test-user-email'];
  req.session = { destroy(cb) { delete this.user; cb && cb(); } };
  if (email) req.session.user = { email, name: email, role: 'user' };
  next();
});
app.use(makeAuthGuard({ localDevMode: false }));
app.get('/ping', (_req, res) => res.json({ ok: true }));
app.use('/me', userSettingsRouter);
const server = app.listen(0);
const port = server.address().port;
test.after(() => server.close());

function req(method, urlPath, { user = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (user) headers['x-test-user-email'] = user;
    const payload = body === null ? null : JSON.stringify(body);
    if (payload) headers['content-length'] = Buffer.byteLength(payload);
    const r = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* kein JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

test('Loeschung entfernt alle gespeicherten Sitzungen des Kontos, fremde bleiben', async () => {
  const email = 'multi@x.test';
  appUsers.createUser({ email, displayName: 'Multi' });
  appUsers.createUser({ email: 'andere@x.test', displayName: 'Andere' });
  storeSession('s-laptop', email);
  storeSession('s-phone', 'MULTI@x.test');
  storeSession('s-other', 'andere@x.test');

  const res = await req('DELETE', '/me/account', { user: email, body: { confirm: 'DELETE' } });
  assert.equal(res.status, 200);
  assert.equal(sessionCount('s-laptop'), 0);
  assert.equal(sessionCount('s-phone'), 0, 'Gross-/Kleinschreibung der Adresse zaehlt nicht');
  assert.equal(sessionCount('s-other'), 1);
});

test('Auth-Guard: Sitzung eines geloeschten Kontos → 401', async () => {
  const email = 'weg@x.test';
  appUsers.createUser({ email, displayName: 'Weg' });
  assert.equal((await req('GET', '/ping', { user: email })).status, 200);
  await accountDelete.deleteAccount(email);
  const after = await req('GET', '/ping', { user: email });
  assert.equal(after.status, 401);
  assert.equal(after.json.error_code, 'NOT_LOGGED_IN');
});

test('Auth-Guard: Sitzung eines gesperrten Kontos → 401', async () => {
  const email = 'gesperrt@x.test';
  appUsers.createUser({ email, displayName: 'Gesperrt' });
  appUsers.setStatus(email, 'suspended');
  assert.equal((await req('GET', '/ping', { user: email })).status, 401);
});

test('eigenes Buch nicht loeschbar → Konto bleibt, 500 ACCOUNT_DELETE_FAILED mit reason', async () => {
  const email = 'klemmt@x.test';
  appUsers.createUser({ email, displayName: 'Klemmt' });
  const ok = await seedBook(email, 'Geht');
  const stuck = await seedBook(email, 'Klemmt');
  storeSession('s-klemmt', email);

  const orig = contentStore.deleteBook;
  contentStore.deleteBook = async (id, ctx) => {
    if (id === stuck) throw new Error('SQLITE_BUSY');
    return orig(id, ctx);
  };
  try {
    await assert.rejects(accountDelete.deleteAccount(email), (e) => {
      assert.equal(e.code, 'OWNED_BOOKS_NOT_DELETED');
      assert.deepEqual(e.failedBooks, [stuck]);
      return true;
    });
    // Konto, Owner-Zeile des haengenden Buchs und die Sitzung bleiben: ein
    // zweiter Versuch ist moeglich, das Buch bleibt erreichbar.
    assert.ok(appUsers.getUser(email));
    assert.equal(bookAccess.getBookRole(stuck, email), 'owner');
    assert.equal(sessionCount('s-klemmt'), 1);
    // Was schon ging, ist weg (Schritt ist idempotent).
    assert.equal(db.prepare('SELECT COUNT(*) c FROM books WHERE book_id = ?').get(ok).c, 0);

    const res = await req('DELETE', '/me/account', { user: email, body: { confirm: 'DELETE' } });
    assert.equal(res.status, 500);
    assert.equal(res.json.error_code, 'ACCOUNT_DELETE_FAILED');
    assert.equal(res.json.reason, 'OWNED_BOOKS_NOT_DELETED');
    assert.ok(appUsers.getUser(email));
  } finally {
    contentStore.deleteBook = orig;
  }

  // Zweiter Aufruf nach Behebung raeumt den Rest ab.
  const retry = await req('DELETE', '/me/account', { user: email, body: { confirm: 'DELETE' } });
  assert.equal(retry.status, 200);
  assert.equal(appUsers.getUser(email), null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM books WHERE book_id = ?').get(stuck).c, 0);
});
