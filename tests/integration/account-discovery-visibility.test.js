'use strict';
// Zwei Antworten auf dieselbe Frage: „Gibt es diese Adresse bei uns, und wer
// ist sie?" — beide Wege dürfen kein Account-Verzeichnis aufrollen.
//
//   - GET  /me/users-light   Der Sichtkreis muss am Session-User hängen, nicht an
//                            der app_users-Tabelle. Geprüft über die echte Route
//                            (nicht nur über db/user-directory.js), damit ein
//                            späterer Ausweg — eigene Query in der Route, Fallback
//                            auf "alle", ignorierte Session — rot wird.
//   - POST /books/:id/share  Ein gesperrtes oder gelöschtes Konto muss wie eine
//                            unbekannte Adresse antworten; der Status im Fehler
//                            wäre ein Orakel über beliebige E-Mails der Instanz.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

bootstrap();

const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');
const bookAccess = require('../../db/book-access');

const ME = 'sichtbar@test.dev';
const CO = 'mitgeteilttester@test.dev';
const OUTSIDER = 'fremder@test.dev';
const GESPERRT = 'gesperrt@test.dev';
const GELOESCHT = 'geloescht@test.dev';
const MY_BOOK = 9201;

let baseUrl;
let server;
let sessionUser = ME;

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => {
      req.session = sessionUser ? { user: { email: sessionUser } } : {};
      next();
    });
    app.use('/me', require('../../routes/usersettings'));
    app.use('/books', require('../../routes/book-access'));
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function usersLight() {
  const res = await fetch(`${baseUrl}/me/users-light`);
  assert.equal(res.status, 200);
  return (await res.json()).users;
}

async function share(email) {
  const res = await fetch(`${baseUrl}/books/${MY_BOOK}/share`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, role: 'viewer' }),
  });
  return { status: res.status, body: await res.json() };
}

const emailsOf = (rows) => rows.map(r => r.email).sort();

test.before(async () => {
  appUsers.createUser({ email: ME, displayName: 'Sichtbar' });
  appUsers.createUser({ email: CO, displayName: 'Mitgeteilt' });
  appUsers.createUser({ email: OUTSIDER, displayName: 'Fremd' });
  appUsers.createUser({ email: GESPERRT, displayName: 'Gesperrt' });
  appUsers.createUser({ email: GELOESCHT, displayName: 'Geloescht' });
  appUsers.setStatus(GESPERRT, 'suspended');
  appUsers.setStatus(GELOESCHT, 'deleted');

  const now = new Date().toISOString();
  db.prepare(`INSERT INTO books (book_id, name, created_at, updated_at, owner_email)
              VALUES (?, 'Mein Buch', ?, ?, ?)`).run(MY_BOOK, now, now, ME);
  bookAccess.grantAccess(MY_BOOK, ME, 'owner', ME);
  bookAccess.grantAccess(MY_BOOK, CO, 'viewer', ME);

  await startServer();
});

test.after(() => { if (server) server.close(); });

test('sieht sich selbst und das Co-Mitglied, nicht den Dritten', async () => {
  sessionUser = ME;
  assert.deepEqual(emailsOf(await usersLight()), [CO, ME]);
});

test('der Co-Mitglieder sieht umgekehrt dich, aber nicht den Dritten', async () => {
  sessionUser = CO;
  assert.deepEqual(emailsOf(await usersLight()), [CO, ME]);
});

test('ohne Buchkontakte bleibt nur der eigene Account', async () => {
  sessionUser = OUTSIDER;
  assert.deepEqual(emailsOf(await usersLight()), [OUTSIDER]);
});

test('ohne Session ist die Liste leer — kein Fallback auf alle Konten', async () => {
  sessionUser = null;
  assert.deepEqual(await usersLight(), []);
});

test('Share-Orakel: gesperrt und geloescht antworten wie eine unbekannte Adresse', async () => {
  sessionUser = ME;
  const unbekannt = await share('nie@registriert.test.dev');

  for (const adresse of [GESPERRT, GELOESCHT]) {
    const res = await share(adresse);
    assert.deepEqual(res, unbekannt,
      `${adresse} darf sich nicht von einer unbekannten Adresse unterscheiden`);
    assert.equal(JSON.stringify(res.body).includes('suspended'), false);
    assert.equal(JSON.stringify(res.body).includes('deleted'), false);
  }
  assert.equal(unbekannt.status, 404);
  assert.equal(unbekannt.body.error_code, 'USER_NOT_FOUND');
});

test('ein aktives Konto laesst sich weiterhin teilen', async () => {
  sessionUser = ME;
  const res = await share(OUTSIDER);
  assert.equal(res.status, 200);
  assert.equal(bookAccess.getBookRole(MY_BOOK, OUTSIDER), 'viewer');
});
