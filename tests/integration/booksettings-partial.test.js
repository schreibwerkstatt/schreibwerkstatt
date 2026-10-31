'use strict';
// Integration: Bucheinstellungen als Teil-PUT (routes/booksettings.js), die
// book_settings-Zeile mit Owner-Defaults (db/book-settings.js#ensureBookSettingsRow),
// Textsorte ohne Zeile, Schulsystem-Teil-PUT, Kalenderdatum der Deadline, der
// Publikations-Teil-PUT (routes/publication.js) und die Buchtyp-SSoT der
// User-Defaults (routes/usersettings.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const OWNER = 'bs-owner@test.dev';
const EDITOR = 'bs-editor@test.dev';
const NOW = '2026-01-01T00:00:00.000Z';

let db; let server; let baseUrl;

async function call(method, path, body, user = OWNER) {
  const r = await fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

function seedBook(id, owner = OWNER) {
  const { grantAccess } = require('../../db/book-access');
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(id, `Buch ${id}`, NOW, NOW, owner);
  grantAccess(id, owner, 'owner', owner);
  grantAccess(id, EDITOR, 'editor', owner);
  return id;
}

const rowOf = (id) => db.prepare('SELECT * FROM book_settings WHERE book_id = ?').get(id);

test.before(async () => {
  bootstrap();
  db = require('../../db/schema').db;
  for (const u of [OWNER, EDITOR]) db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(u);
  // Owner: englisch/GB, Sachbuch. Editor: deutsch/DE, Roman — sein Default darf
  // ein fremdes Buch nie bestimmen.
  db.prepare("UPDATE app_users SET default_language = 'en', default_region = 'GB', default_buchtyp = 'sachbuch' WHERE email = ?").run(OWNER);
  db.prepare("UPDATE app_users SET default_language = 'de', default_region = 'DE', default_buchtyp = 'roman' WHERE email = ?").run(EDITOR);

  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.headers['x-test-user'] || OWNER } }; next(); });
  app.use('/booksettings', require('../../routes/booksettings'));
  app.use('/publication', require('../../routes/publication'));
  app.use('/me', require('../../routes/usersettings'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test('Teil-PUT: fehlender Key behaelt den Wert, null loescht, Sprache/Region nicht leer', async () => {
  const id = seedBook(9601);
  let r = await call('PUT', `/booksettings/${id}`, {
    language: 'de', region: 'CH', buchtyp: 'roman', stilprofil: 'knapp, trocken',
    daily_goal_chars: 2000, goal_target_chars: 300000, erzaehlperspektive: 'ich',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.locale, 'de-CH');

  // Nur der Buchtyp: alles andere bleibt (insbesondere das Stilprofil).
  r = await call('PUT', `/booksettings/${id}`, { buchtyp: 'krimi' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.buchtyp, 'krimi');
  assert.equal(r.body.stilprofil, 'knapp, trocken');
  assert.equal(r.body.daily_goal_chars, 2000);
  assert.equal(r.body.erzaehlperspektive, 'ich');
  assert.equal(r.body.language, 'de');

  // null = nicht gesetzt (Default), 0 = bewusst kein Tagesziel.
  r = await call('PUT', `/booksettings/${id}`, { daily_goal_chars: 0 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.daily_goal_chars, 0);
  assert.equal((await call('GET', `/booksettings/${id}`)).body.daily_goal_chars, 0);
  r = await call('PUT', `/booksettings/${id}`, { daily_goal_chars: null, erzaehlperspektive: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.daily_goal_chars, null);
  assert.equal(r.body.erzaehlperspektive, null);
  assert.equal(r.body.goal_target_chars, 300000);
  assert.equal((await call('PUT', `/booksettings/${id}`, { daily_goal_chars: 50 })).status, 400);

  r = await call('PUT', `/booksettings/${id}`, { language: '' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error_code, 'LANGUAGE_REGION_REQUIRED');
  assert.equal((await call('PUT', `/booksettings/${id}`, { erzaehlzeit: 'futur' })).body.error_code, 'INVALID_TEMPUS');

  // Buchtyp-SSoT: jeder Typ aus prompt-config.json geht durch.
  assert.equal((await call('PUT', `/booksettings/${id}`, { buchtyp: 'sachbuch' })).status, 200);
  assert.equal((await call('PUT', `/booksettings/${id}`, { buchtyp: 'mondbuch' })).body.error_code, 'INVALID_BUCHTYP');
});

test('allow_lektor_book_chat: nur der Owner setzt es, ein Editor wird still ignoriert', async () => {
  const id = seedBook(9602);
  let r = await call('PUT', `/booksettings/${id}`, { allow_lektor_book_chat: 1, buch_kontext: 'Kontext' }, EDITOR);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.allow_lektor_book_chat, 0);
  assert.equal(r.body.buch_kontext, 'Kontext', 'der Rest des Bodys wird trotzdem gespeichert');
  r = await call('PUT', `/booksettings/${id}`, { allow_lektor_book_chat: 1 });
  assert.equal(r.body.allow_lektor_book_chat, 1);
  r = await call('PUT', `/booksettings/${id}`, { allow_lektor_book_chat: 0 }, EDITOR);
  assert.equal(r.body.allow_lektor_book_chat, 1);
});

test('is_finished 0→1 haelt eine Auto-Fassung fest', async () => {
  const id = seedBook(9603);
  // Eine Fassung braucht Inhalt (leeres Buch → BOOK_EMPTY, keine Fassung).
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, body_html, position, updated_at)
              VALUES (?, ?, 'Abschnitt 1', '<p>Text</p>', 1, ?)`).run(id * 10 + 1, id, NOW);
  const before = db.prepare('SELECT COUNT(*) AS n FROM book_snapshots WHERE book_id = ?').get(id).n;
  const r = await call('PUT', `/booksettings/${id}`, { is_finished: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.body.is_finished, 1);
  let n = before;
  for (let i = 0; i < 50 && n === before; i++) {
    await new Promise((res) => setTimeout(res, 20));
    n = db.prepare('SELECT COUNT(*) AS n FROM book_snapshots WHERE book_id = ?').get(id).n;
  }
  assert.equal(n, before + 1);
});

test('Zeile ohne Formular: Teil-Setter legen sie mit den Owner-Defaults an', async () => {
  const id = seedBook(9604);
  assert.equal(rowOf(id), undefined);
  // Ohne Zeile liest auch der Editor die Defaults des OWNERS.
  let g = await call('GET', `/booksettings/${id}`, null, EDITOR);
  assert.equal(g.body.language, 'en');
  assert.equal(g.body.region, 'GB');
  assert.equal(g.body.buchtyp, 'sachbuch');

  const r = await call('PUT', `/booksettings/${id}/entities-enabled`, { enabled: true }, EDITOR);
  assert.equal(r.status, 200);
  const row = rowOf(id);
  assert.equal(row.language, 'en');
  assert.equal(row.region, 'GB');
  assert.equal(row.buchtyp, 'sachbuch');
  assert.equal(row.entities_enabled, 1);

  // Teil-PUT auf das Formular ohne Sprache/Region: Zeile bleibt englisch.
  const p = await call('PUT', `/booksettings/${id}`, { buch_kontext: 'x' });
  assert.equal(p.status, 200);
  assert.equal(p.body.locale, 'en-GB');
});

test('Textsorte ohne book_settings-Zeile wird gespeichert', async () => {
  const id = seedBook(9605);
  db.prepare("UPDATE app_users SET default_buchtyp = 'journalismus' WHERE email = ?").run(OWNER);
  try {
    const r = await call('PUT', `/booksettings/${id}/textsorte`, { textsorte: 'kommentar' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(rowOf(id).textsorte, 'kommentar');
    assert.equal(rowOf(id).buchtyp, 'journalismus');
    assert.equal((await call('GET', `/booksettings/${id}`)).body.textsorte, 'kommentar');
  } finally {
    db.prepare("UPDATE app_users SET default_buchtyp = 'sachbuch' WHERE email = ?").run(OWNER);
  }
});

test('Schulsystem: fehlender Key laesst es stehen, null entfernt es', async () => {
  const id = seedBook(9606);
  let r = await call('PUT', `/booksettings/${id}/schulsystem`, { schulsystem: { vorlage: 'ch_so_1990' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('PUT', `/booksettings/${id}/schulsystem`, { handlungsjahr: 2001 });
  assert.equal(r.status, 200);
  assert.equal(r.body.schulsystem?.vorlage, 'ch_so_1990');
  assert.equal(r.body.handlungsjahr, 2001);
  r = await call('PUT', `/booksettings/${id}/schulsystem`, { schulsystem: null });
  assert.equal(r.body.schulsystem, null);
  assert.equal(r.body.handlungsjahr, 2001);
});

test('goal_deadline: nur echte Kalendertage', async () => {
  const id = seedBook(9607);
  for (const bad of ['2025-02-30', '2025-13-01', '2025-04-31', '25-01-01']) {
    const r = await call('PUT', `/booksettings/${id}`, { goal_deadline: bad });
    assert.equal(r.status, 400, bad);
  }
  const ok = await call('PUT', `/booksettings/${id}`, { goal_deadline: '2024-02-29' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.goal_deadline, '2024-02-29');
  const clear = await call('PUT', `/booksettings/${id}`, { goal_deadline: '' });
  assert.equal(clear.body.goal_deadline, null);
});

test('Publikation: Teil-PUT behaelt nicht uebergebene Felder', async () => {
  const id = seedBook(9608);
  let r = await call('PUT', `/publication/${id}`, { subtitle: 'Erster Untertitel', author_name: 'Anna Autorin', epub_justify: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await call('PUT', `/publication/${id}`, { subtitle: 'Zweiter Untertitel' });
  assert.equal(r.status, 200);
  assert.equal(r.body.subtitle, 'Zweiter Untertitel');
  assert.equal(r.body.author_name, 'Anna Autorin');
  assert.equal(r.body.epub_justify, false);
});

test('User-Defaults: jeder Buchtyp der SSoT ist als Default erlaubt', async () => {
  const r = await call('PATCH', '/me/settings', { default_buchtyp: 'journalismus' }, EDITOR);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.default_buchtyp, 'journalismus');
  assert.equal((await call('PATCH', '/me/settings', { default_buchtyp: 'mondbuch' }, EDITOR)).status, 400);
});

test('Buchanlage: Zeile mit Anleger-Defaults, Folge-PUT der Anlage-Maske laesst das Stilprofil-Seed stehen', async () => {
  const contentStore = require('../../lib/content-store');
  const { saveAuthorProfileText } = require('../../db/author-profile');
  saveAuthorProfileText(OWNER, 'Kurze Saetze, viel Weissraum.');
  const created = await contentStore.createBook({ name: 'Neu', owner_email: OWNER }, { session: { user: { email: OWNER } } });
  const row = rowOf(created.id);
  assert.ok(row, 'Zeile entsteht bei der Anlage');
  assert.equal(row.language, 'en');
  assert.equal(row.region, 'GB');
  assert.equal(row.stilprofil, 'Kurze Saetze, viel Weissraum.');

  require('../../db/book-access').grantAccess(created.id, OWNER, 'owner', OWNER);
  // Genau der Body, den public/js/book/book-create.js schickt.
  const r = await call('PUT', `/booksettings/${created.id}`, { language: 'de', region: 'CH', buchtyp: 'roman' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.stilprofil, 'Kurze Saetze, viel Weissraum.');
  assert.equal(r.body.buchtyp, 'roman');
  assert.equal(r.body.locale, 'de-CH');
});
