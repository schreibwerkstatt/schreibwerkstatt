'use strict';
// Integration: Schulsystem + Schulweg-Routen (routes/booksettings.js /schulsystem,
// routes/figures-schulweg.js). ACL (viewer liest, editor schreibt, Fremder 403),
// Validierung gegen das Buch-Schulsystem, Vorschlag übernehmen/verwerfen —
// der Vorschlag überschreibt Autor-Felder nie von selbst.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const ME = 'schule-autor@test.dev';
const VIEWER = 'schule-viewer@test.dev';
const STRANGER = 'schule-fremd@test.dev';
const BOOK = 9521;
const NOW = '2026-01-01T00:00:00.000Z';

let db; let server; let baseUrl; let annaId;

async function call(method, path, body, user = ME) {
  const r = await fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test.before(async () => {
  bootstrap();
  db = require('../../db/schema').db;
  const { grantAccess } = require('../../db/book-access');
  for (const u of [ME, VIEWER, STRANGER]) db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(u);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, 'Der Amoklauf', NOW, NOW, ME);
  grantAccess(BOOK, ME, 'owner', ME);
  grantAccess(BOOK, VIEWER, 'viewer', ME);

  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.headers['x-test-user'] || ME } }; next(); });
  app.use('/booksettings', require('../../routes/booksettings'));
  app.use('/figures', require('../../routes/figures-schulweg'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });

  annaId = db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, geburtstag, sort_order, updated_at)
    VALUES (?, ?, 'fig_anna', 'Anna Berg', '12.3.1985', 0, ?)`).run(BOOK, ME, NOW).lastInsertRowid;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test('Schulsystem: ohne System 400 beim Schulweg, Vorlage wird normalisiert gespeichert', async () => {
  const put0 = await call('PUT', `/figures/${BOOK}/schulwege/fig_anna`, { weg: 'bez' });
  assert.equal(put0.status, 400);
  assert.equal(put0.body.error_code, 'SCHULSYSTEM_MISSING');

  assert.equal((await call('PUT', `/booksettings/${BOOK}/schulsystem`, { schulsystem: { vorlage: 'mars' } })).status, 400);
  const r = await call('PUT', `/booksettings/${BOOK}/schulsystem`, { schulsystem: { vorlage: 'ch_so_1990', jahre: { obergym: 99 } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.schulsystem.jahre.obergym, 10, 'geklemmt');
  assert.equal(r.body.schulsystem.stichtag.monat, 4);
  const get = await call('GET', `/booksettings/${BOOK}`);
  assert.equal(get.body.schulsystem.vorlage, 'ch_so_1990');
});

test('Schulsystem: Viewer darf nicht schreiben, Fremder nicht lesen', async () => {
  assert.equal((await call('PUT', `/booksettings/${BOOK}/schulsystem`, { schulsystem: null }, VIEWER)).status, 403);
  assert.equal((await call('GET', `/figures/${BOOK}/schulwege`, null, STRANGER)).status, 403);
});

test('Schulweg: Autor setzt, ungültiger Weg 400, Viewer 403, unbekannte Figur 404', async () => {
  assert.equal((await call('PUT', `/figures/${BOOK}/schulwege/fig_anna`, { weg: 'gym' })).status, 400);
  assert.equal((await call('PUT', `/figures/${BOOK}/schulwege/fig_anna`, { weg: 'bez', einschulung_jahr: 12 })).status, 400);
  assert.equal((await call('PUT', `/figures/${BOOK}/schulwege/fig_anna`, { weg: 'bez' }, VIEWER)).status, 403);
  assert.equal((await call('PUT', `/figures/${BOOK}/schulwege/fig_nix`, { weg: 'bez' })).status, 404);

  // Repetitionen fallen nicht still weg: unbekannte Stufe, eine Klasse, die der Weg
  // nicht durchläuft (bez_gym verlässt die Bez nach der 2.), oder zu viele → 400.
  for (const repetitionen of [
    [{ stufe: 'primar', klasse: 3 }, { stufe: 'gibtsnicht', klasse: 1 }],
    [{ stufe: 'bez', klasse: 3 }],
    [{ stufe: 'sek', klasse: 1 }],
    [1, 2, 3, 4, 5].map(k => ({ stufe: 'primar', klasse: k })),
  ]) {
    const bad = await call('PUT', `/figures/${BOOK}/schulwege/fig_anna`, { weg: 'bez_gym', repetitionen });
    assert.equal(bad.status, 400, JSON.stringify(repetitionen));
    assert.equal(bad.body.error_code, 'SCHULWEG_REPETITION_INVALID');
  }

  const r = await call('PUT', `/figures/${BOOK}/schulwege/fig_anna`, {
    weg: 'bez_gym', einschulung_jahr: 1991,
    repetitionen: [{ stufe: 'primar', klasse: 3 }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.schulweg.weg, 'bez_gym');
  assert.equal(r.body.schulweg.source, 'autor');
  assert.deepEqual(r.body.schulweg.repetitionen, [{ stufe: 'primar', klasse: 3 }]);

  const list = await call('GET', `/figures/${BOOK}/schulwege`, null, VIEWER);
  assert.equal(list.status, 200);
  // Viewer sieht nur die eigenen Figuren (Figuren sind pro User) — hier also keine.
  assert.deepEqual(list.body.wege, {});
  const own = await call('GET', `/figures/${BOOK}/schulwege`);
  assert.equal(own.body.wege.fig_anna.einschulung_jahr, 1991);
  // Geburt kommt vom Server (Steckbrief «12.3.1985»), damit der Browser nicht selbst herleitet.
  assert.deepEqual(own.body.geburten.fig_anna, { y: 1985, m: 3, d: 12, quelle: 'steckbrief' });
});

test('Handlungsjahr: reist mit dem Schulsystem, fehlender Key lässt es stehen', async () => {
  const sys = { vorlage: 'ch_so_1990' };
  assert.equal((await call('PUT', `/booksettings/${BOOK}/schulsystem`, { schulsystem: sys, handlungsjahr: 12 })).status, 400);
  const r = await call('PUT', `/booksettings/${BOOK}/schulsystem`, { schulsystem: sys, handlungsjahr: 1999 });
  assert.equal(r.body.handlungsjahr, 1999);
  await call('PUT', `/booksettings/${BOOK}/schulsystem`, { schulsystem: sys });
  assert.equal((await call('GET', `/booksettings/${BOOK}`)).body.handlungsjahr, 1999);
  assert.equal((await call('GET', `/figures/${BOOK}/schulwege`)).body.handlungsjahr, 1999);
  await call('PUT', `/booksettings/${BOOK}/schulsystem`, { schulsystem: sys, handlungsjahr: null });
  assert.equal((await call('GET', `/booksettings/${BOOK}`)).body.handlungsjahr, null);
});

test('Vorschlag: liegt neben den Autor-Feldern, Übernehmen kopiert, Verwerfen leert', async () => {
  const { setSchoolPathJobErgebnis, getSchoolPath } = require('../../db/figure-school-paths');
  const setVorschlag = (vorschlag) => setSchoolPathJobErgebnis(annaId, { vorschlag });
  setVorschlag({ weg: 'kanti', zitat: 'Anna ging an die Kanti', page_id: null, repetition: { stufe: 'primar', klasse: 1 } });
  let sp = getSchoolPath(annaId);
  assert.equal(sp.weg, 'bez_gym', 'Vorschlag überschreibt den Autor-Weg nicht');
  assert.equal(sp.vorschlag.weg, 'kanti');

  assert.equal((await call('POST', `/figures/${BOOK}/schulwege/fig_anna/uebernehmen`, null, VIEWER)).status, 403);
  const acc = await call('POST', `/figures/${BOOK}/schulwege/fig_anna/uebernehmen`);
  assert.equal(acc.status, 200);
  assert.equal(acc.body.schulweg.weg, 'kanti');
  assert.equal(acc.body.schulweg.source, 'ki');
  assert.equal(acc.body.schulweg.vorschlag, null);
  assert.equal(acc.body.schulweg.einschulung_jahr, 1991, 'nicht vorgeschlagene Felder bleiben');
  // Die vorgeschlagene Repetition kommt dazu, die bestehende (3. Primar) bleibt.
  assert.deepEqual(acc.body.schulweg.repetitionen, [{ stufe: 'primar', klasse: 3 }, { stufe: 'primar', klasse: 1 }]);
  assert.equal(acc.body.repetitionen_entfernt, 0);
  assert.equal((await call('POST', `/figures/${BOOK}/schulwege/fig_anna/uebernehmen`)).status, 404);

  // Neuer Weg ohne die Stufe einer bestehenden Repetition: sie fällt weg und wird gemeldet.
  await call('PUT', `/figures/${BOOK}/schulwege/fig_anna`, { weg: 'bez', einschulung_jahr: 1991, repetitionen: [{ stufe: 'bez', klasse: 3 }] });
  setVorschlag({ weg: 'kanti', zitat: 'Anna ging an die Kanti', page_id: null });
  const acc2 = await call('POST', `/figures/${BOOK}/schulwege/fig_anna/uebernehmen`);
  assert.equal(acc2.status, 200);
  assert.deepEqual(acc2.body.schulweg.repetitionen, []);
  assert.equal(acc2.body.repetitionen_entfernt, 1);

  setVorschlag({ weg: 'sek', zitat: 'x' });
  const del = await call('DELETE', `/figures/${BOOK}/schulwege/fig_anna/vorschlag`);
  assert.equal(del.status, 200);
  sp = getSchoolPath(annaId);
  assert.equal(sp.vorschlag, null);
  assert.equal(sp.weg, 'kanti');
});

test('Buchtyp ohne Schullaufbahn: System bleibt gespeichert, Schulweg-Routen sehen keins', async () => {
  const setTyp = (t) => db.prepare(`INSERT INTO book_settings (book_id, buchtyp, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(book_id) DO UPDATE SET buchtyp = excluded.buchtyp`).run(BOOK, t, NOW);
  setTyp('sachbuch');
  try {
    assert.equal((await call('GET', `/figures/${BOOK}/schulwege`)).body.schulsystem, null);
    const put = await call('PUT', `/figures/${BOOK}/schulwege/fig_anna`, { weg: 'bez' });
    assert.equal(put.body.error_code, 'SCHULSYSTEM_MISSING');
    assert.equal((await call('GET', `/booksettings/${BOOK}`)).body.schulsystem.vorlage, 'ch_so_1990', 'Einstellung bleibt liegen');
    setTyp('gesellschaft');
    assert.equal((await call('GET', `/figures/${BOOK}/schulwege`)).body.schulsystem.vorlage, 'ch_so_1990');
  } finally {
    setTyp(null);
  }
});

test('Verwerfen und leerer Job-Lauf legen keine Leerzeile an', async () => {
  const { setSchoolPathJobErgebnis } = require('../../db/figure-school-paths');
  const id = db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, sort_order, updated_at)
    VALUES (?, ?, 'fig_leer', 'Leer', 2, ?)`).run(BOOK, ME, NOW).lastInsertRowid;
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM figure_school_paths WHERE figure_id = ?').get(id).n;
  setSchoolPathJobErgebnis(id, { vorschlag: null, klassenangaben: [] });
  assert.equal(count(), 0);
  assert.equal((await call('DELETE', `/figures/${BOOK}/schulwege/fig_leer/vorschlag`)).status, 200);
  assert.equal(count(), 0);
  setSchoolPathJobErgebnis(id, { klassenangaben: [{ jahr: 1999, stufe: 'bez', klasse: 2, zitat: 'z', page_id: null }] });
  assert.equal(count(), 1);
  const own = await call('GET', `/figures/${BOOK}/schulwege`);
  assert.equal(own.body.wege.fig_leer.klassenangaben[0].klasse, 2);
  db.prepare('DELETE FROM figures WHERE id = ?').run(id);
});

test('CASCADE: Figur gelöscht → Schulweg weg', () => {
  const id = db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, sort_order, updated_at)
    VALUES (?, ?, 'fig_tmp', 'Tmp', 1, ?)`).run(BOOK, ME, NOW).lastInsertRowid;
  require('../../db/figure-school-paths').setSchoolPath(id, { weg: 'bez' });
  db.prepare('DELETE FROM figures WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM figure_school_paths WHERE figure_id = ?').get(id).n, 0);
});
