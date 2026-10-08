'use strict';
// Sichtbarkeitsregel aus db/user-directory.js: `GET /me/users-light` darf nur den
// eigenen Account und die Co-Mitglieder der eigenen Bücher nennen — plus die
// Quell-Tripwire, damit die Route nicht wieder direkt app_users ausliest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { useTmpDb } = require('./_helpers/tmp-db');
const tmpDb = useTmpDb('user-directory');

require('../../db/migrations');
const appUsers = require('../../db/app-users');
const bookAccess = require('../../db/book-access');
const { visibleUserDirectory } = require('../../db/user-directory');

function _user(email, displayName) {
  appUsers.createUser({ email, displayName });
}
function _book(id, name, owner) {
  const now = new Date().toISOString();
  require('../../db/connection').db
    .prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(id, name, now, now, owner);
  // Der Owner liegt wie bei jedem Buchanlage-Pfad (routes/content/books.js) in
  // book_access, nicht nur in books.owner_email.
  bookAccess.grantAccess(id, owner, 'owner', owner);
}

test('ohne Buchkontakte sieht ein User exakt sich selbst', () => {
  _user('solo@x.ch', 'Solo');
  _user('fremd@x.ch', 'Fremd');

  assert.deepEqual(visibleUserDirectory('solo@x.ch'), [
    { email: 'solo@x.ch', display_name: 'Solo' },
  ]);
});

test('Co-Mitglieder des eigenen Buchs sind sichtbar — fremde Accounts nicht', () => {
  _book(2001, 'Gemeinsam', 'solo@x.ch');
  bookAccess.grantAccess(2001, 'fremd@x.ch', 'editor', 'solo@x.ch');

  assert.deepEqual(
    visibleUserDirectory('solo@x.ch').map(u => u.email).sort(),
    ['fremd@x.ch', 'solo@x.ch'],
  );
});

test('Sichtbar ist in beide Richtungen: der Owner eines Buchs, in dem ich nur Leser bin', () => {
  _book(2002, 'Fremdes Buch', 'fremd@x.ch');
  bookAccess.grantAccess(2002, 'solo@x.ch', 'viewer', 'fremd@x.ch');

  assert.deepEqual(
    visibleUserDirectory('solo@x.ch').map(u => u.email).sort(),
    ['fremd@x.ch', 'solo@x.ch'],
  );
});

test('Kontakt über ein fremdes Buch ohne mich bleibt unsichtbar', () => {
  _user('dritte@x.ch', 'Dritte');
  _book(2003, 'Ihr Buch', 'fremd@x.ch');
  bookAccess.grantAccess(2003, 'dritte@x.ch', 'editor', 'fremd@x.ch');

  assert.equal(visibleUserDirectory('solo@x.ch').some(u => u.email === 'dritte@x.ch'), false);
  assert.equal(visibleUserDirectory('fremd@x.ch').some(u => u.email === 'dritte@x.ch'), true);
});

test('gesperrte und geloeschte Konten werden nicht herausgegeben', () => {
  _user('weg@x.ch', 'Weg');
  _book(2004, 'Mit Weg', 'solo@x.ch');
  bookAccess.grantAccess(2004, 'weg@x.ch', 'viewer', 'solo@x.ch');
  appUsers.setStatus('weg@x.ch', 'suspended');

  assert.equal(visibleUserDirectory('solo@x.ch').some(u => u.email === 'weg@x.ch'), false);
});

test('Einladung ohne Buchzugriff zaehlt nicht, Einladung mit Buch schon', () => {
  _user('eingeladen@x.ch', 'Eingeladen');
  appUsers.setStatus('eingeladen@x.ch', 'invited');
  assert.equal(visibleUserDirectory('solo@x.ch').some(u => u.email === 'eingeladen@x.ch'), false);

  _book(2005, 'Offen', 'solo@x.ch');
  bookAccess.grantAccess(2005, 'eingeladen@x.ch', 'lektor', 'solo@x.ch');
  assert.equal(visibleUserDirectory('solo@x.ch').some(u => u.email === 'eingeladen@x.ch'), true);
});

test('leeres Ergebnis ohne bzw. mit unbekannter E-Mail', () => {
  assert.deepEqual(visibleUserDirectory(''), []);
  assert.deepEqual(visibleUserDirectory(null), []);
  assert.deepEqual(visibleUserDirectory('niemand@x.ch'), []);
});

test('Quell-Tripwire: die Route liest app_users nicht selbst und nennt keine Rolle', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'routes', 'usersettings.js'), 'utf8');
  const route = src.slice(src.indexOf("router.get('/users-light'"));
  const block = route.slice(0, route.indexOf('\n});') + 4);

  assert.match(block, /visibleUserDirectory\(sessionEmail\(req\)\)/,
    'Route muss den Sichtkreis an db/user-directory delegieren');
  assert.equal(/listUsers/.test(block), false,
    'kein direkter app_users-Zugriff in der Route');
  assert.equal(/global_role/.test(block), false,
    'global_role nicht ausliefern — das bleibt /admin/users');
});
