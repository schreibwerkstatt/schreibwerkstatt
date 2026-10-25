'use strict';
// Gliederung über die echten Content-Router (docs/chapter-hierarchy.md):
//   - GET …/tree trägt `order_updated_at`, GET …/changes `structure_at`
//   - PUT …/order mit veraltetem `expected_updated_at` → 409 ORDER_CONFLICT
//   - POST /content/chapters unter ein Kapitel der Tiefe 3 → 400 CHAPTER_MAX_DEPTH
//   - Kapitel-Umbenennen rückt die Strukturversion vor
// Dazu die Server-Verbraucher, die Kapitel als Teilbaum lesen bzw. in
// Lesereihenfolge sortieren (Quellen-Nummern, Buch-Chat-Filter, Faktencheck).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;

const ME = 'struktur@test.dev';
const NOW = '2026-01-01T00:00:00.000Z';
let BOOK = 9700;

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: ME } }; next(); });
    app.use('/content', require('../../routes/content'));
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(ME);
  await startServer();
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

// Teil (L1) › Kapitel (L2) › Szene (L3), dazu ein zweites Top-Kapitel.
function seed() {
  const bookId = ++BOOK;
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(bookId, 'Struktur', NOW, NOW);
  require('../../db/book-access').grantAccess(bookId, ME, 'owner', ME);
  const ch = (name, parent) => db.prepare(`
    INSERT INTO chapters (book_id, chapter_name, position, parent_chapter_id, updated_at) VALUES (?, ?, 0, ?, ?)
  `).run(bookId, name, parent, NOW).lastInsertRowid;
  const pg = (name, chapterId, html = '<p>x</p>') => db.prepare(`
    INSERT INTO pages (book_id, chapter_id, page_name, body_html, position, updated_at, local_updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `).run(bookId, chapterId, name, html, NOW, NOW).lastInsertRowid;
  const teil = ch('Teil', null);
  const kap = ch('Kapitel', teil);
  const szene = ch('Szene', kap);
  const z = ch('Zwei', null);
  const pTeil = pg('Einleitung', teil);
  const pSzene = pg('In der Szene', szene);
  const pZ = pg('Zwei-Text', z);
  require('../../db/book-order').putOrder(bookId, [
    { type: 'chapter', id: teil, children: [
      { type: 'page', id: pTeil },
      { type: 'chapter', id: kap, children: [{ type: 'chapter', id: szene, children: [{ type: 'page', id: pSzene }] }] },
    ]},
    { type: 'chapter', id: z, children: [{ type: 'page', id: pZ }] },
  ], ME);
  return { bookId, teil, kap, szene, z, pTeil, pSzene, pZ };
}

test('tree trägt order_updated_at, changes trägt dieselbe structure_at', async () => {
  const s = seed();
  const tree = await api('GET', `/content/books/${s.bookId}/tree`);
  assert.equal(tree.status, 200);
  assert.match(tree.json.order_updated_at, /^\d{4}-\d\d-\d\dT/);
  const ch = await api('GET', `/content/books/${s.bookId}/changes?since=${encodeURIComponent(NOW)}`);
  assert.equal(ch.status, 200);
  assert.equal(ch.json.structure_at, tree.json.order_updated_at);
});

test('PUT order: veralteter Stempel → 409 ORDER_CONFLICT, aktueller → 200', async () => {
  const s = seed();
  const base = (await api('GET', `/content/books/${s.bookId}/tree`)).json.order_updated_at;
  const swapped = [
    { type: 'chapter', id: s.z, children: [{ type: 'page', id: s.pZ }] },
    { type: 'chapter', id: s.teil, children: [
      { type: 'page', id: s.pTeil },
      { type: 'chapter', id: s.kap, children: [{ type: 'chapter', id: s.szene, children: [{ type: 'page', id: s.pSzene }] }] },
    ]},
  ];
  // Fremde Änderung dazwischen: Umbenennen rückt die Strukturversion vor.
  db.prepare('UPDATE book_order SET updated_at = ? WHERE book_id = ?').run('2000-01-01T00:00:00.000Z', s.bookId);
  const rn = await api('PUT', `/content/chapters/${s.z}`, { name: 'Zwei neu' });
  assert.equal(rn.status, 200);
  const stale = await api('PUT', `/content/books/${s.bookId}/order`, { order_json: swapped, expected_updated_at: base });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error_code, 'ORDER_CONFLICT');
  assert.ok(stale.json.updated_at);
  const ok = await api('PUT', `/content/books/${s.bookId}/order`, { order_json: swapped, expected_updated_at: stale.json.updated_at });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.tree[0].id, s.z);
  // Ohne Stempel bleibt der Weg offen (ältere Clients).
  const legacy = await api('PUT', `/content/books/${s.bookId}/order`, { order_json: swapped });
  assert.equal(legacy.status, 200);
});

test('POST chapters: Elternkapitel auf Ebene 3 → 400 CHAPTER_MAX_DEPTH', async () => {
  const s = seed();
  const deep = await api('POST', '/content/chapters', { book_id: s.bookId, name: 'Zu tief', parent_chapter_id: s.szene });
  assert.equal(deep.status, 400);
  assert.equal(deep.json.error_code, 'CHAPTER_MAX_DEPTH');
  const ok = await api('POST', '/content/chapters', { book_id: s.bookId, name: 'Szene 2', parent_chapter_id: s.kap });
  assert.equal(ok.status, 200);
  const t = require('../../db/book-order').getOrder(s.bookId).tree;
  const kapNode = t[0].children.find(n => n.id === s.kap);
  assert.deepEqual(kapNode.children.map(n => n.id), [s.szene, ok.json.id]);
});

test('PUT chapters ohne Name/Ausschluss (nur position) → 400 EMPTY_BODY', async () => {
  const s = seed();
  const r = await api('PUT', `/content/chapters/${s.z}`, { position: 0 });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'EMPTY_BODY');
});

test('Buch-Chat-Filter: Kapitel meint den ganzen Teilbaum', () => {
  const s = seed();
  const { listPagesForPassageSearch, listPagesForDialogue } = require('../../db/book-chat/text');
  const { listPagesWithBody } = require('../../db/book-chat/analysis');
  const ids = (rows) => rows.map(r => r.page_id).sort((a, b) => a - b);
  const expected = [s.pTeil, s.pSzene].sort((a, b) => a - b);
  assert.deepEqual(ids(listPagesForPassageSearch(s.bookId, { chapterId: s.teil })), expected);
  assert.deepEqual(ids(listPagesForDialogue(s.bookId, { chapterId: s.teil })), expected);
  assert.deepEqual(ids(listPagesWithBody(s.bookId, { chapterId: s.teil })), expected);
  assert.deepEqual(ids(listPagesWithBody(s.bookId, { chapterId: s.kap })), [s.pSzene]);
});

test('Quellen-Fundstellen in Lesereihenfolge über Kapitelgrenzen', () => {
  const s = seed();
  // pTeil (Kapitel «Teil», position 0) vor pSzene (Unter-Unterkapitel, position 0)
  // vor pZ (Kapitel «Zwei», position 0) — p.position allein ist überall 0.
  const src = (title) => db.prepare(`
    INSERT INTO sources (owner_email, csl_type, authors, editors, title, archived, created_at, updated_at)
    VALUES (?, 'book', '[]', '[]', ?, 0, ?, ?)
  `).run(ME, title, NOW, NOW).lastInsertRowid;
  const [a, b, c] = [src('A'), src('B'), src('C')];
  const cite = db.prepare(`INSERT INTO source_citations (source_id, page_id, count, first_offset, quote_chars, paraphrase_count)
                           VALUES (?, ?, 1, 0, 0, 0)`);
  cite.run(c, s.pZ);
  cite.run(b, s.pSzene);
  cite.run(a, s.pTeil);
  const rows = require('../../db/sources/citations').listBookCitations(s.bookId);
  assert.deepEqual(rows.map(r => r.page_id), [s.pTeil, s.pSzene, s.pZ]);
});

test('Faktencheck-Befund behält gleichnamige Kapitel per ID', () => {
  const s = seed();
  const ein1 = db.prepare(`INSERT INTO chapters (book_id, chapter_name, position, parent_chapter_id, updated_at)
                           VALUES (?, 'Einleitung', 0, ?, ?)`).run(s.bookId, s.teil, NOW).lastInsertRowid;
  const ein2 = db.prepare(`INSERT INTO chapters (book_id, chapter_name, position, parent_chapter_id, updated_at)
                           VALUES (?, 'Einleitung', 0, ?, ?)`).run(s.bookId, s.z, NOW).lastInsertRowid;
  const { saveFaktencheckIssues } = require('../../db/continuity');
  const { chapterIdsByName } = require('../../db/content-names');
  const { normalizedIssues } = saveFaktencheckIssues(s.bookId, ME, 'test', [{
    schwere: 'mittel', typ: 'faktenfehler', beschreibung: 'b', stelle_a: 'a', stelle_b: '', empfehlung: '',
    figuren: [], kapitel: ['Einleitung'],
    chapter_refs: [{ chapter_id: ein2, chapter_name: 'Einleitung' }],
  }], {}, chapterIdsByName(s.bookId), '');
  assert.deepEqual(normalizedIssues[0].chapter_ids, [ein2]);
  assert.notEqual(ein1, ein2);
});
