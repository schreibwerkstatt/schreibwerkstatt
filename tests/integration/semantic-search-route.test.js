'use strict';
// Route-Test GET /search/semantic — „Ähnliche Stellen zu Entität" + Treffer-Skopierung.
//   - like_kind=figure mit der TEXT-ID (fig_id), wie die Figuren-Karte sie schickt,
//     und weiterhin mit dem INTEGER-PK
//   - like_kind=location mit loc_id
//   - Quelle aus fremdem Buch / vom Co-Autor → 404 (kein Existenz-Leak, kein
//     Retrieval mit fremdem Vektor)
//   - Treffer: Co-Autor-Figuren fallen weg, verschobene Seiten (anderes Buch) auch
//   - notIndexed wird durchgereicht
// Kein Embedding-Endpunkt: die Vektoren werden von Hand gesetzt, der like-Pfad
// embeddet nichts.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
let semanticRetrieval;
let origIndexReady;
let indexReadyValue = true;

const ME = 'autor@test.dev';
const COAUTHOR = 'ko@test.dev';
const BOOK = 9301;
const OTHER_BOOK = 9302;
const NOW = '2026-01-01T00:00:00.000Z';
const MODEL = 'test-embed';
const DIM = 3;
const V = Float32Array.from([1, 0, 0]);
const NEAR = Float32Array.from([0.9, 0.44, 0]);

const ids = {};

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: ME } }; next(); });
    app.use('/search', require('../../routes/search'));
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
    server.on('error', reject);
  });
}

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

const row = (vector, text) => ({ chunk_ix: 0, content_hash: 'h' + text, vector, text });

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  const appSettings = require('../../lib/app-settings');
  appSettings.set('embed.enabled', true);
  appSettings.set('embed.host', 'http://embed.invalid');
  appSettings.set('embed.model', MODEL);
  appSettings.set('embed.dim', DIM);
  semanticRetrieval = require('../../lib/semantic-retrieval');
  origIndexReady = semanticRetrieval.indexReady;
  semanticRetrieval.indexReady = () => indexReadyValue;
  await startServer();
});
test.after(() => {
  if (semanticRetrieval) semanticRetrieval.indexReady = origIndexReady;
  if (server) server.close();
  ctx.cleanup();
});

test.beforeEach(() => {
  indexReadyValue = true;
  for (const t of ['semantic_chunks', 'figures', 'locations', 'book_access']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare('DELETE FROM pages').run();
  db.prepare('DELETE FROM chapters').run();
  db.prepare('DELETE FROM books').run();
  const { grantAccess } = require('../../db/book-access');
  for (const u of [ME, COAUTHOR]) db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(u);
  const insBook = db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
  insBook.run(BOOK, 'Buch', NOW, NOW);
  insBook.run(OTHER_BOOK, 'Anderes Buch', NOW, NOW);
  grantAccess(BOOK, ME, 'owner', ME);
  grantAccess(BOOK, COAUTHOR, 'editor', ME);
  grantAccess(OTHER_BOOK, COAUTHOR, 'owner', COAUTHOR);

  const insFig = db.prepare('INSERT INTO figures (book_id, fig_id, name, user_email, updated_at) VALUES (?, ?, ?, ?, ?)');
  ids.myFig = insFig.run(BOOK, 'fig_1', 'Anna', ME, NOW).lastInsertRowid;
  ids.myFig2 = insFig.run(BOOK, 'fig_2', 'Bruno', ME, NOW).lastInsertRowid;
  ids.coFig = insFig.run(BOOK, 'fig_1', 'Ko-Anna', COAUTHOR, NOW).lastInsertRowid;
  ids.foreignFig = insFig.run(OTHER_BOOK, 'fig_9', 'Fremd', COAUTHOR, NOW).lastInsertRowid;
  const insLoc = db.prepare('INSERT INTO locations (book_id, loc_id, name, user_email, updated_at) VALUES (?, ?, ?, ?, ?)');
  ids.myLoc = insLoc.run(BOOK, 'loc_1', 'Hafen', ME, NOW).lastInsertRowid;

  const insChap = db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, 0, ?)');
  insChap.run(93011, BOOK, 'K1', NOW);
  insChap.run(93021, OTHER_BOOK, 'K2', NOW);
  const insPage = db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, updated_at, body_html)
                              VALUES (?, ?, ?, ?, 0, ?, '<p>x</p>')`);
  insPage.run(930111, BOOK, 'Eigene Seite', 93011, NOW);
  insPage.run(930112, BOOK, 'Verschobene Seite', 93011, NOW);

  const sc = require('../../db/semantic-chunks');
  sc.replaceEntity('figure', ids.myFig, BOOK, MODEL, DIM, [row(V, 'Anna am Hafen')]);
  sc.replaceEntity('figure', ids.myFig2, BOOK, MODEL, DIM, [row(NEAR, 'Bruno')]);
  sc.replaceEntity('figure', ids.coFig, BOOK, MODEL, DIM, [row(NEAR, 'Ko-Figur')]);
  sc.replaceEntity('location', ids.myLoc, BOOK, MODEL, DIM, [row(NEAR, 'Der Hafen')]);
  sc.replaceEntity('page', 930111, BOOK, MODEL, DIM, [row(NEAR, 'Seitentext')]);
  sc.replaceEntity('page', 930112, BOOK, MODEL, DIM, [row(NEAR, 'Alter Text')]);
  // Seite nach dem Indexlauf in ein anderes Buch verschoben — Chunk hängt noch am alten.
  db.prepare('UPDATE pages SET book_id = ?, chapter_id = ? WHERE page_id = ?').run(OTHER_BOOK, 93021, 930112);
});

function keys(hits) { return hits.map(h => `${h.kind}:${h.entity_id}`).sort(); }

test('like_kind=figure mit fig_id: Treffer, ohne Co-Autor-Figur und ohne verschobene Seite', async () => {
  const r = await get(`/search/semantic?book_id=${BOOK}&like_kind=figure&like_id=fig_1`);
  assert.equal(r.status, 200);
  assert.deepEqual(keys(r.json.hits), [`figure:${ids.myFig2}`, `location:${ids.myLoc}`, 'page:930111'].sort());
  assert.equal(r.json.notIndexed, false);
  const loc = r.json.hits.find(h => h.kind === 'location');
  assert.equal(loc.title, 'Hafen');
  assert.equal(loc.nav_id, 'loc_1');
  assert.equal(r.json.hits.find(h => h.kind === 'figure').nav_id, 'fig_2');
});

test('like_kind=figure mit INTEGER-PK funktioniert weiterhin', async () => {
  const r = await get(`/search/semantic?book_id=${BOOK}&like_kind=figure&like_id=${ids.myFig}`);
  assert.equal(r.status, 200);
  assert.ok(r.json.hits.length > 0);
  assert.ok(!r.json.hits.some(h => h.kind === 'figure' && h.entity_id === ids.myFig), 'Quelle ausgeschlossen');
});

test('like_kind=location mit loc_id', async () => {
  const r = await get(`/search/semantic?book_id=${BOOK}&like_kind=location&like_id=loc_1`);
  assert.equal(r.status, 200);
  assert.ok(r.json.hits.some(h => h.kind === 'figure' && h.entity_id === ids.myFig));
});

test('fremde Quellen → 404, gleich wie nicht vorhanden', async () => {
  for (const q of [
    `like_kind=figure&like_id=${ids.foreignFig}`, // fremdes Buch
    'like_kind=figure&like_id=fig_9',
    `like_kind=figure&like_id=${ids.coFig}`, // Co-Autor im selben Buch
    'like_kind=page&like_id=930112', // verschobene Seite
    'like_kind=figure&like_id=999999',
    'like_kind=figure&like_id=fig_404',
  ]) {
    const r = await get(`/search/semantic?book_id=${BOOK}&${q}`);
    assert.equal(r.status, 404, q);
    assert.equal(r.json.error_code, 'LIKE_ENTITY_NOT_FOUND', q);
  }
});

test('notIndexed wird durchgereicht', async () => {
  indexReadyValue = false;
  const r = await get(`/search/semantic?book_id=${BOOK}&like_kind=figure&like_id=fig_1`);
  assert.equal(r.status, 200);
  assert.equal(r.json.notIndexed, true);
});
