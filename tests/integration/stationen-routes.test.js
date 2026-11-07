'use strict';
// Integration: Berufsweg/Hobbys-Routen (routes/figures-stationen.js). ACL (viewer
// liest, editor schreibt, Fremder 403), Validierung über die Rechenschicht,
// Vorschlag übernehmen/verwerfen, Zeile gehört nur zur eigenen Figur.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const ME = 'station-autor@test.dev';
const VIEWER = 'station-viewer@test.dev';
const STRANGER = 'station-fremd@test.dev';
const BOOK = 9531;
const NOW = '2026-01-01T00:00:00.000Z';

let db; let server; let baseUrl; let annaId; let beatId;

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
  grantAccess(BOOK, VIEWER, 'editor', ME);

  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.headers['x-test-user'] || ME } }; next(); });
  app.use('/figures', require('../../routes/figures-stationen'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });

  const ins = db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, sort_order, updated_at) VALUES (?, ?, ?, ?, 0, ?)`);
  annaId = ins.run(BOOK, ME, 'fig_anna', 'Anna Berg', NOW).lastInsertRowid;
  beatId = ins.run(BOOK, ME, 'fig_beat', 'Beat Keller', NOW).lastInsertRowid;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test('Anlegen, Ändern, Lesen nach fig_id; ungültige Angaben 400', async () => {
  const bad = await call('POST', `/figures/${BOOK}/stationen/berufe/fig_anna`, { taetigkeit: '' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error_code, 'STATION_INVALID');
  assert.equal((await call('POST', `/figures/${BOOK}/stationen/berufe/fig_anna`, { taetigkeit: 'Koch', von_jahr: 2000, bis_jahr: 1990 })).status, 400);
  assert.equal((await call('POST', `/figures/${BOOK}/stationen/mars/fig_anna`, { hobby: 'x' })).status, 400);
  assert.equal((await call('POST', `/figures/${BOOK}/stationen/hobbys/fig_nix`, { hobby: 'x' })).status, 404);

  const r = await call('POST', `/figures/${BOOK}/stationen/berufe/fig_anna`, { taetigkeit: 'Pflegefachfrau', art: 'beruf', von_jahr: 2003, zitat: 'eingeschmuggelt' });
  assert.equal(r.status, 200);
  assert.equal(r.body.station.source, 'autor');
  assert.equal(r.body.station.zitat, null, 'Beleg setzt nur der Job');
  const id = r.body.station.id;

  const put = await call('PUT', `/figures/${BOOK}/stationen/berufe/fig_anna/${id}`, { taetigkeit: 'Pflegefachfrau HF', von_jahr: 2003, bis_jahr: 2010 });
  assert.equal(put.status, 200);
  assert.equal(put.body.station.bis_jahr, 2010);
  // Zeile gehört Anna, nicht Beat.
  assert.equal((await call('PUT', `/figures/${BOOK}/stationen/berufe/fig_beat/${id}`, { taetigkeit: 'x' })).status, 404);

  await call('POST', `/figures/${BOOK}/stationen/hobbys/fig_anna`, { hobby: 'Unihockey' });
  const get = await call('GET', `/figures/${BOOK}/stationen`, null, VIEWER);
  assert.equal(get.status, 200);
  assert.deepEqual(Object.keys(get.body).sort(), ['berufe', 'hobbys']);
  // Viewer hat eigene (leere) Figuren — Figuren sind pro User.
  assert.deepEqual(get.body.berufe, {});
  const mine = await call('GET', `/figures/${BOOK}/stationen`);
  assert.equal(mine.body.berufe.fig_anna[0].taetigkeit, 'Pflegefachfrau HF');
  assert.equal(mine.body.hobbys.fig_anna[0].hobby, 'Unihockey');
});

test('Fremder 403 beim Lesen und Schreiben', async () => {
  assert.equal((await call('GET', `/figures/${BOOK}/stationen`, null, STRANGER)).status, 403);
  assert.equal((await call('POST', `/figures/${BOOK}/stationen/hobbys/fig_anna`, { hobby: 'x' }, STRANGER)).status, 403);
});

test('Vorschlag übernehmen macht ihn aktiv (source ki), Verwerfen löscht; aktive Zeile ist nicht «übernehmbar»', async () => {
  const st = require('../../db/figure-stationen');
  const v1 = st.createStation('berufe', beatId, { taetigkeit: 'Mechaniker', art: 'ausbildung', zitat: 'Lehre als Mechaniker' }, { status: 'vorschlag', source: 'ki' });
  const v2 = st.createStation('hobbys', beatId, { hobby: 'Schach' }, { status: 'vorschlag', source: 'ki' });

  const acc = await call('POST', `/figures/${BOOK}/stationen/berufe/fig_beat/${v1.id}/uebernehmen`);
  assert.equal(acc.status, 200);
  assert.equal(acc.body.station.status, 'aktiv');
  assert.equal(acc.body.station.source, 'ki');
  assert.equal(acc.body.station.zitat, 'Lehre als Mechaniker', 'Beleg bleibt');
  assert.equal((await call('POST', `/figures/${BOOK}/stationen/berufe/fig_beat/${v1.id}/uebernehmen`)).status, 404);

  assert.equal((await call('DELETE', `/figures/${BOOK}/stationen/hobbys/fig_beat/${v2.id}`)).status, 200);
  assert.equal(st.listStationenForFigure('hobbys', beatId).length, 0);
  assert.equal((await call('DELETE', `/figures/${BOOK}/stationen/hobbys/fig_beat/${v2.id}`)).status, 404);
});

test('Figur löschen räumt ihre Stationen (CASCADE)', async () => {
  const st = require('../../db/figure-stationen');
  assert.ok(st.listStationenForFigure('berufe', annaId).length > 0);
  db.prepare('DELETE FROM figures WHERE id = ?').run(annaId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM figure_jobs WHERE figure_id = ?').get(annaId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM figure_hobbies WHERE figure_id = ?').get(annaId).n, 0);
});
