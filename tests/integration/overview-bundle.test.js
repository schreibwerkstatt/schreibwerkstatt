'use strict';
// Integration: gebündelte Buch-Übersicht GET /overview/:book_id (routes/overview.js).
//
// Geprüft wird, was die Unit-Tests des Clients nicht sehen:
//   * Parität: jeder Teil liefert exakt die Antwort seiner Einzel-Route (dieselben
//     Builder) — sonst rechnete die Übersicht mit anderen Daten als die Fachkarte.
//   * Rechte je Teil: ein Betrachter bekommt die editor-Teile als `forbidden`, die
//     übrigen als Daten; ohne Buchzugang antwortet die Route selbst mit 403.
//   * `?skip=` lässt Teile aus; die Rückblick-Coverage gibt es nur für Tagebücher.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');
const dummy = require('./_helpers/dummy-book');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const OWNER = 'ov-owner@test.dev';
const VIEWER = 'ov-viewer@test.dev';
const STRANGER = 'ov-stranger@test.dev';
const BOOK = 131;

let ctx; let server; let baseUrl;

test.before(async () => {
  ctx = bootstrap();
  const { db } = require('../../db/schema');
  const appUsers = require('../../db/app-users');
  const bookAccess = require('../../db/book-access');
  for (const email of [OWNER, VIEWER, STRANGER]) if (!appUsers.getUser(email)) appUsers.createUser({ email });
  dummy.seedDummyBook(ctx.dbSeed, BOOK);
  db.prepare('UPDATE books SET owner_email = ? WHERE book_id = ?').run(OWNER, BOOK);
  bookAccess.grantAccess(BOOK, OWNER, 'owner', OWNER);
  bookAccess.grantAccess(BOOK, VIEWER, 'viewer', OWNER);

  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.headers['x-test-user'] } }; next(); });
  app.use('/overview', require('../../routes/overview'));
  app.use('/history', require('../../routes/history'));
  app.use('/usage', require('../../routes/usage'));
  app.use('/figures', require('../../routes/figures'));
  app.use('/locations', require('../../routes/locations'));
  app.use('/songs', require('../../routes/songs'));
  app.use('/plot', require('../../routes/plot'));
  app.use('/motifs', require('../../routes/motifs'));
  app.use('/lexicon', require('../../routes/lexicon'));
  app.use('/ideen', require('../../routes/ideen'));
  app.use('/chat', require('../../routes/chat'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

async function get(path, user) {
  const r = await fetch(`${baseUrl}${path}`, { headers: { 'x-test-user': user } });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// Einzel-Route je Teil (so, wie die Übersicht sie vor der Bündelung abfragte).
const SINGLE = {
  coverage: `/history/coverage/${BOOK}`,
  heat: `/history/fehler-heatmap/${BOOK}?mode=open`,
  review: `/history/review/${BOOK}`,
  recent: `/usage/page/recent?book_id=${BOOK}&limit=8`,
  figuren: `/figures/${BOOK}`,
  szenen: `/figures/scenes/${BOOK}`,
  orte: `/locations/${BOOK}`,
  songs: `/songs/${BOOK}`,
  lektorat: `/history/lektorat-time/${BOOK}`,
  plot: `/plot?book_id=${BOOK}`,
  motifs: `/motifs?book_id=${BOOK}`,
  lexicon: `/lexicon/${BOOK}?summary=1`,
  ideen: `/ideen/board?book_id=${BOOK}`,
};

test('Owner: jeder Teil = Antwort der Einzel-Route', async () => {
  const { status, json } = await get(`/overview/${BOOK}`, OWNER);
  assert.equal(status, 200);
  for (const [key, path] of Object.entries(SINGLE)) {
    const single = await get(path, OWNER);
    assert.equal(single.status, 200, `${key}: Einzel-Route`);
    const expected = structuredClone(single.json);
    // Den Embed-Index-Status hängt nur die Motiv-Karte an; die Übersicht braucht ihn nicht.
    if (key === 'motifs') delete expected.embedIndex;
    assert.deepEqual(json.parts[key], { data: expected }, key);
  }
  const sessions = await get(`/chat/sessions/book/${BOOK}`, OWNER);
  assert.deepEqual(json.parts.bookChat, { data: { count: sessions.json.length } });
  assert.equal(json.parts.rueckblick, undefined, 'kein Tagebuch → kein Rückblick-Teil');
});

test('Betrachter: editor-Teile forbidden, übrige als Daten', async () => {
  const { status, json } = await get(`/overview/${BOOK}`, VIEWER);
  assert.equal(status, 200);
  for (const key of ['figuren', 'szenen', 'orte', 'songs', 'plot', 'ideen']) {
    assert.deepEqual(json.parts[key], { forbidden: true }, key);
  }
  for (const key of ['coverage', 'heat', 'review', 'recent', 'lektorat', 'motifs', 'lexicon', 'bookChat']) {
    assert.ok('data' in json.parts[key], key);
  }
  assert.equal(json.parts.lexicon.data.isOwner, false);
});

test('ohne Buchzugang: 403 der Route selbst', async () => {
  const { status, json } = await get(`/overview/${BOOK}`, STRANGER);
  assert.equal(status, 403);
  assert.equal(json.error_code, 'NO_BOOK_ACCESS');
});

test('skip lässt Teile aus', async () => {
  const { json } = await get(`/overview/${BOOK}?skip=figuren,orte,szenen`, OWNER);
  assert.equal(json.parts.figuren, undefined);
  assert.equal(json.parts.orte, undefined);
  assert.equal(json.parts.szenen, undefined);
  assert.ok(json.parts.coverage);
});

test('Tagebuch: Rückblick-Coverage = Einzel-Route', async () => {
  const { saveBookSettings, getBookSettings } = require('../../db/book-settings');
  const prev = getBookSettings(BOOK) || {};
  saveBookSettings(BOOK, { ...prev, buchtyp: 'tagebuch' });
  try {
    const { json } = await get(`/overview/${BOOK}`, OWNER);
    const single = await get(`/history/rueckblick-coverage/${BOOK}`, OWNER);
    assert.deepEqual(json.parts.rueckblick, { data: single.json });
  } finally {
    saveBookSettings(BOOK, { ...prev, buchtyp: prev.buchtyp ?? null });
  }
});
