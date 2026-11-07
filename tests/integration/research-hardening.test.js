'use strict';
// Integration: Eingangspruefung und Randfaelle des Recherche-Boards.
//   - strikte Feldpruefung (INVALID_FIELD/INVALID_URL/INVALID_KIND) in POST/PATCH
//     und POST /capture
//   - Prototyp-Schluessel als Verknuepfungs-Art → 400 bzw. ignoriert, nie 500
//   - PATCH ist eine Transaktion
//   - Volltextsuche gescheitert → 503 SEARCH_FAILED statt ungefilterter Liste
//   - Bulk add_tag respektiert MAX_TAGS (`skipped`)
//   - Medien: ACL vor dem Body-Parser, Art-Wechsel nur aus note/link
//   - Kapitel-Stelle = ganzer Teilbaum (itemIdsAtPlace, placePageIds)
//   - Welt-Uebersicht der Chats: nur aktive Figuren

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
let sessionUser = 'autor@test.dev';
const NOW = '2026-01-01T00:00:00.000Z';

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: sessionUser } }; next(); });
    app.use('/research', require('../../routes/research'));
    app.use('/capture', require('../../routes/capture'));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error_code: err.status === 413 ? 'TOO_LARGE' : 'INTERNAL' }));
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
    server.on('error', reject);
  });
}

async function api(method, path, body, headers = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) opts.body = body;
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const res = await fetch(`${baseUrl}${path}`, opts);
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  await startServer();
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });
test.beforeEach(() => {
  sessionUser = 'autor@test.dev';
  for (const t of ['research_item_tags', 'research_item_links', 'research_item_urls', 'research_items',
    'figures', 'pages', 'chapters', 'book_access', 'books']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

function seedBook(bookId, user = 'autor@test.dev') {
  const { grantAccess } = require('../../db/book-access');
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Testbuch', ?, ?)").run(bookId, NOW, NOW);
  grantAccess(bookId, user, 'editor', user);
}
function addChapter(bookId, name, position, parent = null) {
  return db.prepare(
    'INSERT INTO chapters (book_id, chapter_name, position, parent_chapter_id, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(bookId, name, position, parent, NOW).lastInsertRowid;
}
function addPage(bookId, chapterId, name, position) {
  return db.prepare(
    'INSERT INTO pages (book_id, page_name, chapter_id, position, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(bookId, name, chapterId, position, NOW).lastInsertRowid;
}
async function createItem(bookId, fields = {}) {
  const { status, json } = await api('POST', '/research', { book_id: bookId, title: 'Notiz', ...fields });
  assert.equal(status, 200, JSON.stringify(json));
  return json;
}

// ── Strikte Feldpruefung ─────────────────────────────────────────────────────

test('POST: nicht-http- oder ueberlange URL → 400 INVALID_URL, nichts angelegt', async () => {
  seedBook(9101);
  let r = await api('POST', '/research', { book_id: 9101, title: 'X', urls: ['javascript:alert(1)'] });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'INVALID_URL');
  r = await api('POST', '/research', { book_id: 9101, title: 'X', urls: [`https://a.example/${'x'.repeat(2001)}`] });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'INVALID_URL');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM research_items').get().n, 0);
});

test('POST: Textfeld mit falschem Typ → 400 INVALID_FIELD mit Feldname; kind image wird note', async () => {
  seedBook(9102);
  const r = await api('POST', '/research', { book_id: 9102, title: 'X', body: 42 });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error_code: 'INVALID_FIELD', params: { field: 'body' } });
  const item = await createItem(9102, { kind: 'image', title: null, body: 'Text' });
  assert.equal(item.kind, 'note');
});

test('PATCH: Typpruefung je Feld, ein Fehler schreibt auch die gueltigen nicht', async () => {
  seedBook(9103);
  const item = await createItem(9103, { title: 'Alt' });
  for (const [patch, field] of [[{ title: 7 }, 'title'], [{ source: {} }, 'source'], [{ pinned: 'ja' }, 'pinned'], [{ archived: 2 }, 'archived']]) {
    const r = await api('PATCH', `/research/${item.id}`, patch);
    assert.equal(r.status, 400, JSON.stringify(patch));
    assert.deepEqual(r.json, { error_code: 'INVALID_FIELD', params: { field } });
  }
  let r = await api('PATCH', `/research/${item.id}`, { title: 'Neu', urls: ['ftp://a.example'] });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'INVALID_URL');
  assert.equal(db.prepare('SELECT title FROM research_items WHERE id = ?').get(item.id).title, 'Alt');
  // Schalter als Boolean oder 0/1; title null loescht.
  r = await api('PATCH', `/research/${item.id}`, { pinned: true, archived: 0, title: null });
  assert.equal(r.status, 200);
  assert.equal(r.json.pinned, 1);
  assert.equal(r.json.title, null);
});

test('PATCH kind: image nicht setzbar, unveraendert mitgeschickte Upload-Art bleibt bearbeitbar', async () => {
  seedBook(9104);
  const item = await createItem(9104);
  let r = await api('PATCH', `/research/${item.id}`, { kind: 'image' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'INVALID_KIND');
  db.prepare("UPDATE research_items SET kind = 'document' WHERE id = ?").run(item.id);
  r = await api('PATCH', `/research/${item.id}`, { kind: 'document', title: 'Bearbeitet' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.kind, 'document');
  assert.equal(r.json.title, 'Bearbeitet');
});

test('POST /capture: ueberlange URL → 400 INVALID_URL statt Kuerzen; Textfeld-Typ geprueft', async () => {
  seedBook(9105);
  let r = await api('POST', '/capture', { book_id: 9105, url: `https://a.example/${'x'.repeat(2001)}` });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'INVALID_URL');
  r = await api('POST', '/capture', { book_id: 9105, url: 'https://a.example/', title: ['x'] });
  assert.equal(r.status, 400);
  assert.deepEqual(r.json, { error_code: 'INVALID_FIELD', params: { field: 'title' } });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM research_items').get().n, 0);
});

// ── Prototyp-Schluessel ──────────────────────────────────────────────────────

test('Prototyp-Schluessel als Verknuepfungs-Art: 400 bzw. ignoriert, nie 500', async () => {
  seedBook(9106);
  const item = await createItem(9106);
  for (const q of ['linked=constructor:1', 'linked=__proto__:1', 'sort=link:constructor', 'sort=link:toString', 'sort=constructor']) {
    const r = await api('GET', `/research?book_id=9106&${q}`);
    assert.equal(r.status, 200, q);
    assert.equal(r.json.length, 1, q);
  }
  for (const kind of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    let r = await api('POST', `/research/${item.id}/links`, { target_kind: kind, target_id: 1 });
    assert.equal(r.status, 400, kind);
    assert.equal(r.json.error_code, 'INVALID_TARGET');
    r = await api('POST', '/research/bulk', { book_id: 9106, ids: [item.id], action: 'link', target_kind: kind, target_id: 1 });
    assert.equal(r.status, 400, kind);
    assert.equal(r.json.error_code, 'INVALID_TARGET');
  }
  const { addItemLink } = require('../../db/research-items');
  assert.equal(addItemLink(item.id, 9106, 'constructor', 1), 'INVALID_TARGET');
});

// ── PATCH als Transaktion ────────────────────────────────────────────────────

test('PATCH: scheitert ein Teilschritt, bleibt das ganze Fundstueck unveraendert', async () => {
  seedBook(9107);
  const item = await createItem(9107, { title: 'Alt', urls: ['https://alt.example'] });
  db.exec(`CREATE TEMP TRIGGER research_tag_boom BEFORE INSERT ON research_item_tags
           BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  try {
    const r = await api('PATCH', `/research/${item.id}`, { title: 'Neu', urls: ['https://neu.example'], status: 'in_arbeit', tags: ['x'] });
    assert.equal(r.status, 500);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS research_tag_boom');
  }
  const row = db.prepare('SELECT title, status FROM research_items WHERE id = ?').get(item.id);
  assert.deepEqual({ ...row }, { title: 'Alt', status: 'offen' });
  assert.deepEqual(db.prepare('SELECT url FROM research_item_urls WHERE item_id = ?').all(item.id).map(r => r.url), ['https://alt.example']);
});

// ── Volltextsuche gescheitert ────────────────────────────────────────────────

test('GET ?q=: Suchfehler → 503 SEARCH_FAILED statt ungefilterter Liste', async () => {
  seedBook(9108);
  await createItem(9108);
  const search = require('../../lib/search');
  const orig = search.query;
  search.query = () => { throw new Error('fts kaputt'); };
  try {
    const r = await api('GET', '/research?book_id=9108&q=irgendwas');
    assert.equal(r.status, 503);
    assert.equal(r.json.error_code, 'SEARCH_FAILED');
  } finally {
    search.query = orig;
  }
});

// ── Bulk add_tag ─────────────────────────────────────────────────────────────

test('POST /bulk add_tag: Fundstueck am Tag-Deckel wird uebersprungen und gemeldet', async () => {
  seedBook(9109);
  const { MAX_TAGS } = require('../../lib/research-validate');
  const full = await createItem(9109, { tags: Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`) });
  const has = await createItem(9109, { tags: ['Rom'] });
  const free = await createItem(9109);
  const r = await api('POST', '/research/bulk', { book_id: 9109, ids: [full.id, has.id, free.id], action: 'add_tag', tag: 'rom' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true, count: 2, skipped: 1 });
  const n = (id) => db.prepare('SELECT COUNT(*) n FROM research_item_tags WHERE item_id = ?').get(id).n;
  assert.equal(n(full.id), MAX_TAGS);
  assert.equal(n(has.id), 1, 'schon vorhanden (andere Schreibweise) → kein zweiter Tag');
  assert.equal(n(free.id), 1);
});

// ── Medien ───────────────────────────────────────────────────────────────────

async function pngBuffer() {
  const sharp = require('sharp');
  return sharp({ create: { width: 4, height: 4, channels: 3, background: '#c33' } }).png().toBuffer();
}

test('Bild-Upload: ACL vor dem Body-Parser — Unberechtigter bekommt 403, nicht 413', async () => {
  seedBook(9110);
  const item = await createItem(9110);
  sessionUser = 'eindringling@test.dev';
  const big = Buffer.alloc(13 * 1024 * 1024, 1);
  let r = await api('POST', `/research/${item.id}/image`, big, { 'Content-Type': 'image/png' });
  assert.equal(r.status, 403);
  r = await api('POST', `/research/${item.id}/doc?name=a.pdf`, big, { 'Content-Type': 'application/pdf' });
  assert.equal(r.status, 403);
});

test('Audio-Upload: ACL vor dem Body-Parser — angekuendigte Ueberlaenge ergibt fuer Unberechtigte 403, nicht 413', async () => {
  seedBook(9112);
  const item = await createItem(9112);
  sessionUser = 'eindringling@test.dev';
  // Content-Length ueber dem Audio-Deckel (200 MB): ein Body-Parser VOR der ACL
  // lehnt schon am Header mit 413 ab; die ACL davor antwortet 403, ohne zu lesen.
  const http = require('node:http');
  const status = await new Promise((resolve, reject) => {
    const u = new URL(`${baseUrl}/research/${item.id}/audio`);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(300 * 1024 * 1024) } }, (res) => {
      res.resume(); resolve(res.statusCode); req.destroy();
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    // Ein Parser vor der ACL wartet auf die angekuendigten Bytes — ohne Deckel
    // hinge der Test, statt rot zu werden.
    req.setTimeout(3000, () => { resolve('timeout'); req.destroy(); });
    req.write(Buffer.alloc(1024));
  });
  assert.equal(status, 403);
});

test('Bild-Upload/-Loeschen: Art wechselt nur aus note/link, Dokument rueckt nach', async () => {
  seedBook(9111);
  const png = await pngBuffer();
  const note = await createItem(9111);
  const quote = await createItem(9111, { kind: 'quote' });

  let r = await api('POST', `/research/${note.id}/image`, png, { 'Content-Type': 'image/png' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.kind, 'image');
  r = await api('POST', `/research/${quote.id}/image`, png, { 'Content-Type': 'image/png' });
  assert.equal(r.json.kind, 'quote', 'Zitat bleibt Zitat');

  // Bild weg, Dokument haengt an → document; ohne Dokument → note.
  db.prepare("UPDATE research_items SET doc = x'25504446', doc_mime = 'application/pdf' WHERE id = ?").run(note.id);
  r = await api('DELETE', `/research/${note.id}/image`);
  assert.equal(r.json.kind, 'document');
  r = await api('DELETE', `/research/${note.id}/doc`);
  assert.equal(r.json.kind, 'note');
  r = await api('DELETE', `/research/${quote.id}/image`);
  assert.equal(r.json.kind, 'quote');
});

// ── Kapitel-Stelle = Teilbaum ────────────────────────────────────────────────

test('itemIdsAtPlace + placePageIds: ein Kapitel umfasst seine Unterkapitel', async () => {
  seedBook(9112);
  const teil = addChapter(9112, 'Erster Teil', 0);
  const unter = addChapter(9112, 'Unterkapitel', 1, teil);
  const andere = addChapter(9112, 'Zweiter Teil', 1);
  const pTeil = addPage(9112, teil, 'Vorwort', 0);
  const pUnter1 = addPage(9112, unter, 'Szene 1', 0);
  const pUnter2 = addPage(9112, unter, 'Szene 2', 1);
  const pAndere = addPage(9112, andere, 'Anderswo', 0);

  const atUnterPage = await createItem(9112, { title: 'an Szene 2' });
  const atUnterChapter = await createItem(9112, { title: 'am Unterkapitel' });
  const atTeil = await createItem(9112, { title: 'am Teil' });
  const elsewhere = await createItem(9112, { title: 'anderswo' });
  const link = (id, kind, tid) => api('POST', `/research/${id}/links`, { target_kind: kind, target_id: tid });
  await link(atUnterPage.id, 'page', pUnter2);
  await link(atUnterChapter.id, 'chapter', unter);
  await link(atTeil.id, 'chapter', teil);
  await link(elsewhere.id, 'page', pAndere);

  const { itemIdsAtPlace } = require('../../db/research-items');
  assert.deepEqual(itemIdsAtPlace(9112, { chapterId: teil }).sort(),
    [atUnterPage.id, atUnterChapter.id, atTeil.id].sort());
  assert.deepEqual(itemIdsAtPlace(9112, { chapterId: unter }).sort(), [atUnterPage.id, atUnterChapter.id].sort());

  const { placePageIds } = require('../../db/research-findings');
  // Lesereihenfolge: eigener Abschnitt des Teils vor denen des Unterkapitels.
  assert.deepEqual(placePageIds(atTeil.id), [pTeil, pUnter1, pUnter2]);
  assert.deepEqual(placePageIds(atTeil.id, { maxPerChapter: 2 }), [pTeil, pUnter1]);
});

// ── Welt-Uebersicht ──────────────────────────────────────────────────────────

test('Welt-Entitaeten: Chat-Liste nur aktive Figuren mit fig_id, Link-Picker alle mit PK', () => {
  seedBook(9113);
  const ins = db.prepare(
    `INSERT INTO figures (book_id, user_email, fig_id, name, sort_order, stale, updated_at) VALUES (9113, 'autor@test.dev', ?, ?, ?, ?, ?)`
  );
  const aktiv = ins.run('f1', 'Anna', 0, 0, NOW).lastInsertRowid;
  const alt = ins.run('f2', 'Berta', 1, 1, NOW).lastInsertRowid;
  const { listBookEntityRows } = require('../../db/book-chat/research');
  assert.deepEqual(listBookEntityRows('figur', 9113, 'autor@test.dev').map(r => [r.id, r.label]), [['f1', 'Anna']]);
  const { listEntityLinkTargets } = require('../../db/research-items');
  assert.deepEqual(listEntityLinkTargets(9113, 'autor@test.dev').figure.map(r => r.id), [aktiv, alt]);
});
