'use strict';
// App + Seed für den Client-Vertragstest (tests/integration/client-contract.test.js).
//
// Anders als die übrigen Integrationstests läuft hier die ECHTE Auth-Kette der
// nativen Clients: Bearer `swd_…` → lib/auth-guard.js (tryDeviceAuth) →
// lib/device-scopes.js (deviceScopeGate) → dieselben Router an denselben
// Mount-Punkten wie server.js. Eine Session-Attrappe würde genau die Schicht
// überspringen, an der ein Client mit 401/403 scheitert.

const express = require('express');
const { createEphemeralSession } = require('../../../lib/token-session');

const ME = 'autor@test.dev';
const OTHER = 'mitarbeit@test.dev';
const BOOK = 7001;
const CH_PART = 7101;
const CH_SUB = 7102;
const PAGE_MAIN = 70001;
const PAGE_SUB = 70002;
const PAGE_TOP = 70003;
const PAGE_GONE = 70004;
const PAGE_LOCKED = 70005;
const T0 = '2026-01-01T00:00:00.000Z';

const MAIN_HTML = '<p data-bid="c0000000000000a1">Erster Absatz.</p>'
  + '<p data-bid="c0000000000000a2">Zweiter Absatz.</p>'
  + '<p data-bid="c0000000000000a3">Dritter Absatz.</p>';

// Mount-Reihenfolge wie server.js — nur die Router, die ein nativer Client anfragt.
function buildApp() {
  const app = express();
  app.use((req, _res, next) => { req.session = createEphemeralSession(); next(); });
  app.use(require('../../../lib/auth-guard').makeAuthGuard({ localDevMode: false }));
  app.use(require('../../../lib/device-scopes').deviceScopeGate);
  app.use(require('../../../routes/proxies').router);
  app.use('/history', require('../../../routes/history'));
  app.use('/jobs', require('../../../routes/jobs').router);
  app.use('/research', require('../../../routes/research'));
  app.use('/booksettings', require('../../../routes/booksettings'));
  app.use('/me', require('../../../routes/usersettings'));
  app.use('/export', require('../../../routes/export'));
  app.use('/content', require('../../../routes/content'));
  app.use('/dictionary', require('../../../routes/dictionary'));
  return app;
}

function seed(db) {
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(BOOK, 'Vertragsbuch', T0, T0);
  const ch = db.prepare(`INSERT INTO chapters (chapter_id, book_id, chapter_name, position, parent_chapter_id, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?)`);
  ch.run(CH_PART, BOOK, 'Teil eins', 0, null, T0);
  ch.run(CH_SUB, BOOK, 'Unterkapitel', 0, CH_PART, T0);
  const pg = db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, updated_at, body_html)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`);
  pg.run(PAGE_MAIN, BOOK, 'Anfang', CH_PART, 0, T0, MAIN_HTML);
  pg.run(PAGE_SUB, BOOK, 'Mitte', CH_SUB, 0, T0, '<p data-bid="c0000000000000b1">Im Unterkapitel.</p>');
  pg.run(PAGE_TOP, BOOK, 'Vorwort', null, 0, T0, '<p data-bid="c0000000000000c1">Ohne Kapitel.</p>');
  pg.run(PAGE_GONE, BOOK, 'Verworfen', CH_PART, 1, T0, '<p data-bid="c0000000000000d1">Fliegt raus.</p>');
  pg.run(PAGE_LOCKED, BOOK, 'Im Lektorat', CH_PART, 2, T0, '<p data-bid="c0000000000000e1">Gesperrt.</p>');
  const access = require('../../../db/book-access');
  access.grantAccess(BOOK, ME, 'owner', ME);
  access.grantAccess(BOOK, OTHER, 'editor', ME);
  access.acquireLock(PAGE_LOCKED, BOOK, OTHER, 'lektorat');

  const tokens = require('../../../db/device-tokens');
  const { TOKEN_KINDS } = require('../../../lib/device-scopes');
  const device = tokens.createDeviceToken({ userEmail: ME, deviceName: 'Vertrags-Mac', platform: 'macos', scopes: TOKEN_KINDS.device });
  const capture = tokens.createDeviceToken({ userEmail: ME, deviceName: 'Vertrags-Erweiterung', platform: 'chrome', scopes: TOKEN_KINDS.capture });
  return { deviceToken: device.plain_token, captureToken: capture.plain_token };
}

module.exports = {
  buildApp, seed,
  ME, OTHER, BOOK, CH_PART, CH_SUB, PAGE_MAIN, PAGE_SUB, PAGE_TOP, PAGE_GONE, PAGE_LOCKED, T0, MAIN_HTML,
};
