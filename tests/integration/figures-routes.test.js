'use strict';
// Integration: Figuren-Katalog-Routen (routes/figures.js).
//   * PUT /figures/:book_id baut die Namens→ID-Maps über den Content-Store —
//     erste_erwaehnung_page_id und Beleg-IDs überleben den GET→PUT-Round-Trip.
//   * PATCH /figures/:book_id/:fig_id pflegt eine Figur (manually_edited), ACL editor.
//   * POST /figures/:book_id/merge per Zeilen-ID (Redundanz-Radar) inkl. Alias, und per
//     fig_id für zwei AKTIVE Figuren (Aktionsmenü der Figurenkarte) samt Beziehungen/Szenen.

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

test('Ich-Erzählstimme + Rufnamen: Analyse setzt, Autor korrigiert, PUT löscht keine Rufnamen', async () => {
  const { saveFigurenToDb } = require('../../db/figures');
  const idMaps = { chNameToId: { 'Kapitel 1': CH }, pageNameToIdByChapter: { [CH]: { Anfang: PAGE } } };
  const analyse = (erz) => saveFigurenToDb(BOOK, [
    { id: 'fig_1', name: 'Anna Berg', ist_erzaehler: erz, weitere_namen: ['Anni', 'Anna Berg', 'anni'] },
    { id: 'fig_2', name: 'Paul Kern' }, { id: 'fig_3', name: 'Pauli' },
  ], ME, idMaps, { reconcile: true, onMissing: 'stale' });
  analyse(true);
  let anna = (await call('GET', `/figures/${BOOK}`)).body.figuren.find(f => f.name === 'Anna Berg');
  assert.equal(anna.ist_erzaehler, true);
  assert.deepEqual(anna.weitere_namen, ['Anni'], 'ohne Name und ohne Doppel');

  // Katalog-PUT eines Clients, der die Rufnamen nicht mitschickt: sie bleiben.
  const get = await call('GET', `/figures/${BOOK}`);
  const stripped = get.body.figuren.map(({ weitere_namen: _w, ...f }) => f);
  assert.equal((await call('PUT', `/figures/${BOOK}`, { figuren: stripped })).status, 200);
  anna = (await call('GET', `/figures/${BOOK}`)).body.figuren.find(f => f.name === 'Anna Berg');
  assert.deepEqual(anna.weitere_namen, ['Anni']);

  // Der Autor nimmt die Markierung zurück — der nächste Lauf setzt sie nicht wieder.
  assert.equal((await call('PATCH', `/figures/${BOOK}/${anna.id}`, { fields: { ist_erzaehler: 'ja' } })).status, 400);
  const r = await call('PATCH', `/figures/${BOOK}/${anna.id}`, { fields: { ist_erzaehler: false } });
  assert.deepEqual(r.body.changed, ['ist_erzaehler']);
  analyse(true);
  anna = (await call('GET', `/figures/${BOOK}`)).body.figuren.find(f => f.name === 'Anna Berg');
  assert.equal(anna.ist_erzaehler, false);
  assert.equal(anna.manually_edited, true);
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

test('GET /figures/chapter meldet den Rückfall auf die ganze Besetzung (fallback)', async () => {
  // Ohne Auftritte im Kapitel: ganze Besetzung, als Rückfall gekennzeichnet —
  // der Referenz-Slot darf daraus kein «im Kapitel» ableiten.
  db.prepare(`DELETE FROM figure_appearances WHERE chapter_id = ?`).run(CH);
  const none = await call('GET', `/figures/chapter/${BOOK}/${CH}`);
  assert.equal(none.status, 200);
  assert.equal(none.body.fallback, true);
  assert.ok(none.body.figuren.length >= 2);

  // Mit Auftritt: nur die Figuren des Kapitels, kein Rückfall.
  const row = db.prepare(`SELECT id FROM figures WHERE book_id = ? AND fig_id = 'fig_1'`).get(BOOK);
  db.prepare(`INSERT INTO figure_appearances (figure_id, chapter_id, haeufigkeit) VALUES (?, ?, 3)`).run(row.id, CH);
  const some = await call('GET', `/figures/chapter/${BOOK}/${CH}`);
  assert.equal(some.body.fallback, false);
  assert.deepEqual(some.body.figuren.map(f => f.id), ['fig_1']);
});

test('Merge zweier AKTIVER Figuren per fig_id (Katalog-Menü): Beziehungen, Szenen, Alias', async () => {
  const { saveFigurenToDb } = require('../../db/figures');
  const idMaps = { chNameToId: { 'Kapitel 1': CH }, pageNameToIdByChapter: { [CH]: { Anfang: PAGE } } };
  // Zwei aktive Figuren, die sich gegenseitig kennen, plus eine Dritte, die beide kennt.
  saveFigurenToDb(BOOK, [
    { id: 'fig_m1', name: 'Marta Lind', kurzname: 'Marta',
      beziehungen: [{ figur_id: 'fig_m2', typ: 'freund' }, { figur_id: 'fig_m3', typ: 'kollege' }] },
    { id: 'fig_m2', name: 'Martha Lind', beziehungen: [{ figur_id: 'fig_m3', typ: 'kollege' }] },
    { id: 'fig_m3', name: 'Otto Hahn' },
  ], ME, idMaps, { reconcile: true, onMissing: 'stale' });
  const row = (fig) => db.prepare('SELECT id, stale FROM figures WHERE book_id = ? AND fig_id = ?').get(BOOK, fig);
  const src = row('fig_m1'); const tgt = row('fig_m2'); const third = row('fig_m3');
  assert.equal(src.stale, 0, 'Quelle ist aktiv');
  assert.equal(tgt.stale, 0, 'Ziel ist aktiv');
  // Szene mit der Quelle: der Bezug muss aufs Ziel wandern.
  const scene = db.prepare(`INSERT INTO figure_scenes (book_id, user_email, titel, chapter_id, page_id, stale)
                            VALUES (?, ?, 'Treffen', ?, ?, 0)`).run(BOOK, ME, CH, PAGE).lastInsertRowid;
  db.prepare('INSERT INTO scene_figures (scene_id, figure_id) VALUES (?, ?)').run(scene, src.id);

  // Viewer darf nicht zusammenführen.
  assert.equal((await call('POST', `/figures/${BOOK}/merge`, { source: 'fig_m1', target: 'fig_m2' }, VIEWER)).status, 403);

  const r = await call('POST', `/figures/${BOOK}/merge`, { source: 'fig_m1', target: 'fig_m2' });
  assert.equal(r.status, 200);
  assert.ok(r.body.aliasesAdded.includes('Marta Lind'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM figures WHERE id = ?').get(src.id).n, 0, 'Quelle gelöscht');

  const rels = db.prepare('SELECT from_fig_id, to_fig_id FROM figure_relations WHERE book_id = ? AND (from_fig_id = ? OR to_fig_id = ?)')
    .all(BOOK, tgt.id, tgt.id);
  assert.ok(!rels.some(x => x.from_fig_id === x.to_fig_id), 'kein Selbstbezug');
  assert.equal(rels.filter(x => (x.from_fig_id === tgt.id && x.to_fig_id === third.id)).length, 1, 'Dublette zum Dritten fällt weg');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scene_figures WHERE scene_id = ? AND figure_id = ?').get(scene, tgt.id).n, 1,
    'Szenen-Bezug hängt am Ziel');
  assert.equal(db.prepare('SELECT stale FROM figures WHERE id = ?').get(tgt.id).stale, 0, 'Ziel bleibt aktiv');
});
