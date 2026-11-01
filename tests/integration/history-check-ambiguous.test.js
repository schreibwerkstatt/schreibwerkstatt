'use strict';
// PATCH /history/check/:id/ambiguous (routes/history/checks.js): Befunde eines
// Lektorat-Laufs als mehrdeutig markieren — der Notebook-Edit-Modus meldet
// Stellen, die beim Schreiben mehrfach vorkamen (public/js/editor/lektorat-live.js).
//   - setzt `mehrdeutig` nur an den genannten `original`s, nie zurück
//   - übrige Felder und Befunde bleiben unverändert, `saved` wird nicht berührt
//   - fremder Lauf 404, ungültiger Body 400
//
// Fährt den echten History-Router unter Express hoch; die Fake-Session liefert den User.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
let sessionUser;

const ME = 'autorin@ambig.test';
const OTHER = 'fremd@ambig.test';
const BOOK = 9401;
const PAGE = 94011;
const NOW = '2026-01-01T00:00:00.000Z';

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => {
      req.session = sessionUser ? { user: { email: sessionUser } } : {};
      next();
    });
    app.use('/history', require('../../routes/history'));
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function patch(id, body) {
  const res = await fetch(`${baseUrl}/history/check/${id}/ambiguous`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

const FINDINGS = [
  { typ: 'grammatik', original: 'sagte er kommt', korrektur: 'sagte, er kommt', erklaerung: 'x' },
  { typ: 'rechtschreibung', original: 'Ein Fhler', korrektur: 'Ein Fehler', erklaerung: 'y' },
];

let ownId;
let foreignId;

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  await startServer();
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

test.beforeEach(() => {
  sessionUser = ME;
  const { grantAccess } = require('../../db/book-access');
  for (const u of [ME, OTHER]) db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(u);
  for (const t of ['page_checks', 'book_access']) db.prepare(`DELETE FROM ${t}`).run();
  ctx.dbSeed._wipeDb?.();
  db.prepare('DELETE FROM pages').run();
  db.prepare('DELETE FROM chapters').run();
  db.prepare('DELETE FROM books').run();
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(BOOK, 'Roman', NOW, NOW);
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, updated_at, body_html)
              VALUES (?, ?, 'Eins', NULL, 0, ?, '<p>x</p>')`).run(PAGE, BOOK, NOW);
  grantAccess(BOOK, ME, 'owner', ME);
  grantAccess(BOOK, OTHER, 'editor', ME);
  const ins = db.prepare(`INSERT INTO page_checks (page_id, book_id, checked_at, error_count, errors_json, user_email, saved)
                          VALUES (?, ?, ?, ?, ?, ?, 0)`);
  ownId = ins.run(PAGE, BOOK, NOW, 2, JSON.stringify(FINDINGS), ME).lastInsertRowid;
  foreignId = ins.run(PAGE, BOOK, NOW, 2, JSON.stringify(FINDINGS), OTHER).lastInsertRowid;
});

const errorsOf = (id) => JSON.parse(db.prepare('SELECT errors_json FROM page_checks WHERE id = ?').get(id).errors_json);

test('markiert nur die genannten Befunde, sonst unverändert, saved bleibt 0', async () => {
  const r = await patch(ownId, { originals: ['sagte er kommt', 'gibt es nicht'] });
  assert.equal(r.status, 200);
  assert.equal(r.json.marked, 1);
  const errs = errorsOf(ownId);
  assert.equal(errs[0].mehrdeutig, true);
  assert.equal(errs[0].korrektur, 'sagte, er kommt');
  assert.equal(errs[1].mehrdeutig, undefined);
  assert.equal(db.prepare('SELECT saved FROM page_checks WHERE id = ?').get(ownId).saved, 0);
});

test('zweiter Aufruf ändert nichts (nur setzen, nie zurück)', async () => {
  await patch(ownId, { originals: ['sagte er kommt'] });
  const r = await patch(ownId, { originals: ['sagte er kommt'] });
  assert.equal(r.status, 200);
  assert.equal(r.json.marked, 0);
  assert.equal(errorsOf(ownId)[0].mehrdeutig, true);
});

test('fremder Lauf 404 und unverändert', async () => {
  const r = await patch(foreignId, { originals: ['sagte er kommt'] });
  assert.equal(r.status, 404);
  assert.equal(errorsOf(foreignId)[0].mehrdeutig, undefined);
});

test('ungültiger Body 400', async () => {
  for (const body of [{}, { originals: [] }, { originals: 'x' }, { originals: [1] }]) {
    const r = await patch(ownId, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.error_code, 'INVALID_FINDINGS');
  }
});
