'use strict';
// Integration: Figuren-Katalog-Routen (routes/figures.js).
//   * PUT /figures/:book_id baut die Namens→ID-Maps über den Content-Store —
//     erste_erwaehnung_page_id und Beleg-IDs überleben den GET→PUT-Round-Trip.
//   * PATCH /figures/:book_id/:fig_id pflegt eine Figur (manually_edited), ACL editor.
//   * POST /figures/:book_id/merge per Zeilen-ID (Redundanz-Radar) inkl. Alias.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const ME = 'fig-autor@test.dev';
const VIEWER = 'fig-viewer@test.dev';
const BOOK = 9501;
const CH = 95011;
const PAGE = 950101;
const NOW = '2026-01-01T00:00:00.000Z';

let db; let server; let baseUrl;

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
  for (const u of [ME, VIEWER]) db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(u);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
    .run(BOOK, 'Buch', NOW, NOW, ME);
  grantAccess(BOOK, ME, 'owner', ME);
  grantAccess(BOOK, VIEWER, 'viewer', ME);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, 0, ?)')
    .run(CH, BOOK, 'Kapitel 1', NOW);
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, updated_at, body_html)
              VALUES (?, ?, ?, ?, 0, ?, '<p>x</p>')`).run(PAGE, BOOK, 'Anfang', CH, NOW);

  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.headers['x-test-user'] || ME } }; next(); });
  app.use('/figures', require('../../routes/figures'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });

  // Analyse-Stand mit aufgelöster erster Erwähnung und Beleg.
  const { saveFigurenToDb } = require('../../db/figures');
  saveFigurenToDb(BOOK, [
    { id: 'fig_1', name: 'Anna Berg', erste_erwaehnung: 'Anfang', kapitel: [{ name: 'Kapitel 1' }],
      beziehungen: [{ figur_id: 'fig_2', typ: 'freund', belege: [{ kapitel: 'Kapitel 1', seite: 'Anfang' }] }] },
    { id: 'fig_2', name: 'Paul Kern' },
    { id: 'fig_3', name: 'Pauli' },
  ], ME, { chNameToId: { 'Kapitel 1': CH }, pageNameToIdByChapter: { [CH]: { Anfang: PAGE } } },
  { reconcile: true, onMissing: 'stale' });
});

test.after(() => new Promise((resolve) => server.close(resolve)));

test('PUT-Round-Trip behält erste_erwaehnung_page_id und Beleg-IDs', async () => {
  const get = await call('GET', `/figures/${BOOK}`);
  assert.equal(get.body.figuren.find(f => f.id === 'fig_1').erste_erwaehnung_page_id, PAGE);
  const put = await call('PUT', `/figures/${BOOK}`, { figuren: get.body.figuren });
  assert.equal(put.status, 200);
  const anna = (await call('GET', `/figures/${BOOK}`)).body.figuren.find(f => f.id === 'fig_1');
  assert.equal(anna.erste_erwaehnung_page_id, PAGE);
  assert.equal(anna.beziehungen[0].belege[0].page_id, PAGE);
  assert.equal(anna.beziehungen[0].belege[0].chapter_id, CH);
});

test('PATCH pflegt eine Figur und markiert sie als vom Autor gepflegt', async () => {
  const r = await call('PATCH', `/figures/${BOOK}/fig_2`, { fields: { beruf: 'Schmied', kurzname: 'Paul' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed.sort(), ['beruf', 'kurzname']);
  const paul = (await call('GET', `/figures/${BOOK}`)).body.figuren.find(f => f.id === 'fig_2');
  assert.equal(paul.beruf, 'Schmied');
  assert.equal(paul.manually_edited, true);
});

test('PATCH: Validierung, unbekannte Figur, Viewer ohne Schreibrecht', async () => {
  assert.equal((await call('PATCH', `/figures/${BOOK}/fig_2`, { fields: { name: '' } })).status, 400);
  assert.equal((await call('PATCH', `/figures/${BOOK}/fig_2`, { fields: { unbekannt: 'x' } })).status, 400);
  assert.equal((await call('PATCH', `/figures/${BOOK}/fig_99`, { fields: { beruf: 'x' } })).status, 404);
  assert.equal((await call('PATCH', `/figures/${BOOK}/fig_2`, { fields: { beruf: 'x' } }, VIEWER)).status, 403);
});

test('Merge per Zeilen-ID: Quelle weg, ihr Name wird Alias des Ziels', async () => {
  const id = (fig) => db.prepare('SELECT id FROM figures WHERE book_id = ? AND fig_id = ?').get(BOOK, fig).id;
  const src = id('fig_3'), tgt = id('fig_2');
  const r = await call('POST', `/figures/${BOOK}/merge`, { source_id: src, target_id: tgt });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.aliasesAdded, ['Pauli']);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM figures WHERE id = ?').get(src).n, 0);
  assert.equal((await call('POST', `/figures/${BOOK}/merge`, { source_id: 'x', target_id: tgt })).status, 400);
  assert.equal((await call('POST', `/figures/${BOOK}/merge`, { source_id: tgt, target_id: tgt })).status, 409);
});
