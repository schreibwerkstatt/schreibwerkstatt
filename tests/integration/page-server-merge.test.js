'use strict';
// Block-Merge auf dem Server beim Stale-Write: `PUT /content/pages/:id` mit
// `base_html` (Client-Vertrag: contract/README.md). Ein nativer Client schickt
// die Basis mit, auf der er schrieb; der Server mergt mit derselben Engine wie
// Notebook/Bucheditor/Mac (public/js/editor/shared/block-merge.js).
//
//   - kollisionsfrei → 200, geschrieben, `merged: true`, beide Änderungen drin
//   - echte Block-Kollision → 409 PAGE_CONFLICT + `merge_conflicts: [bid]`, nichts geschrieben
//   - ohne `base_html` → 409 wie bisher, kein `merge_conflicts`
//   - verschachtelte Blöcke gleichen Tags (Liste in Liste) mergen als EIN Block
//   - der gemergte Write trägt keine Save-Kennung: Wiederholung und Nachfolger mergen erneut

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;

const ME = 'autorin@test.dev';
const BOOK = 9501;
const CHAPTER = 9511;
const PAGE = 95011;
const T0 = '2026-01-01T00:00:00.000Z';
const DEVICE = '0b5c3a1e-6a2f-4c1d-9e1a-5d2c7b9f0a11';

const BASE = '<p data-bid="b0000000000000b1">Eins.</p>'
  + '<ul data-bid="b0000000000000b2"><li>a<ul><li>a1</li></ul></li><li>b</li></ul>'
  + '<p data-bid="b0000000000000b3">Drei.</p>';

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => {
      req.session = { user: { email: ME, via: 'device_token' } };
      next();
    });
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
  return { status: res.status, json: await res.json().catch(() => null) };
}

// Fremder Write (Browser) zwischen Basis und Push des Clients.
async function foreignWrite(html) {
  const cur = await api('GET', `/content/pages/${PAGE}`);
  const r = await api('PUT', `/content/pages/${PAGE}`, { html, expected_updated_at: cur.json.updated_at });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json;
}

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
  for (const t of ['page_revisions', 'book_access', 'book_order']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare('DELETE FROM pages').run();
  db.prepare('DELETE FROM chapters').run();
  db.prepare('DELETE FROM books').run();
  db.prepare('INSERT OR IGNORE INTO app_users (email, created_at) VALUES (?, ?)').run(ME, T0);
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(BOOK, 'Roman', T0, T0);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, 0, ?)')
    .run(CHAPTER, BOOK, 'Kapitel', T0);
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, updated_at, body_html)
              VALUES (?, ?, ?, ?, 0, ?, ?)`).run(PAGE, BOOK, 'Abschnitt', CHAPTER, T0, BASE);
  require('../../db/book-access').grantAccess(BOOK, ME, 'owner', ME);
});

test('kollisionsfrei: Server mergt, schreibt und meldet merged', async () => {
  await foreignWrite(BASE.replace('Eins.', 'Eins, im Browser geändert.'));
  const local = BASE.replace('Drei.', 'Drei, am Handy geändert.');
  const saveId = '6f1c2b8e-2d4a-4b7e-8f3a-1c2d3e4f5a6b';
  const r = await api('PUT', `/content/pages/${PAGE}`, {
    html: local, base_html: BASE, expected_updated_at: T0, device_id: DEVICE, save_id: saveId,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.merged, true);
  assert.match(r.json.html, /Eins, im Browser geändert\./);
  assert.match(r.json.html, /Drei, am Handy geändert\./);
  // Der gemergte Write trägt keine Save-Kennung (routes/content/pages.js#_mergeStaleWrite).
  assert.equal(r.json.last_save_id, null);

  // Antwort verloren, Client wiederholt denselben Push → erneuter Merge, gleiches Ergebnis.
  const again = await api('PUT', `/content/pages/${PAGE}`, {
    html: local, base_html: BASE, expected_updated_at: T0, device_id: DEVICE, save_id: saveId,
  });
  assert.equal(again.status, 200);
  assert.equal(again.json.merged, true);
  const noBids = (h) => h.replace(/\sdata-bid="[^"]*"/g, '');
  assert.equal(noBids(again.json.html), noBids(r.json.html));
});

test('Nachfolger nach verlorener Merge-Antwort überschreibt die fremden Blöcke nicht', async () => {
  await foreignWrite(BASE.replace('Eins.', 'Eins vom Browser.'));
  const first = '9a1c2b8e-2d4a-4b7e-8f3a-1c2d3e4f5a01';
  const local1 = BASE.replace('Drei.', 'Drei, Handy 1.');
  const r1 = await api('PUT', `/content/pages/${PAGE}`, { html: local1, base_html: BASE, expected_updated_at: T0, save_id: first });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.merged, true);
  // Antwort ging verloren: der Client kennt den gemergten Stand nicht. Sein
  // Nachfolger baut auf dem auf, was er zuletzt geschickt hat (Basis = local1),
  // Stempel noch T0, `first` als eigener Vorgänger.
  const r2 = await api('PUT', `/content/pages/${PAGE}`, {
    html: BASE.replace('Drei.', 'Drei, Handy 2.'), base_html: local1, expected_updated_at: T0,
    save_id: '9a1c2b8e-2d4a-4b7e-8f3a-1c2d3e4f5a02', own_save_ids: [first],
  });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  assert.notEqual(r2.json.save_match, 'own');
  assert.match(r2.json.html, /Eins vom Browser\./);
  assert.match(r2.json.html, /Drei, Handy 2\./);
});

test('Block-Kollision: 409 mit merge_conflicts, nichts geschrieben', async () => {
  const foreign = await foreignWrite(BASE.replace('Drei.', 'Drei aus dem Browser.'));
  const r = await api('PUT', `/content/pages/${PAGE}`, {
    html: BASE.replace('Drei.', 'Drei vom Handy.'), base_html: BASE, expected_updated_at: T0, device_id: DEVICE,
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.error_code, 'PAGE_CONFLICT');
  assert.deepEqual(r.json.merge_conflicts, ['b0000000000000b3']);
  assert.equal(r.json.server_updated_at, foreign.updated_at);
  const cur = await api('GET', `/content/pages/${PAGE}`);
  assert.match(cur.json.html, /Drei aus dem Browser\./);
});

test('ohne base_html bleibt der 409 wie bisher', async () => {
  await foreignWrite(BASE.replace('Eins.', 'Eins neu.'));
  const r = await api('PUT', `/content/pages/${PAGE}`, {
    html: BASE.replace('Drei.', 'Drei neu.'), expected_updated_at: T0, device_id: DEVICE,
  });
  assert.equal(r.status, 409);
  assert.equal(r.json.merge_conflicts, undefined);
});

test('verschachtelte Liste ist ein Block: Änderung im Unterpunkt mergt gegen Änderung daneben', async () => {
  await foreignWrite(BASE.replace('Eins.', 'Eins (Browser).'));
  const local = BASE.replace('<li>a1</li>', '<li>a1, ergänzt</li>');
  const r = await api('PUT', `/content/pages/${PAGE}`, { html: local, base_html: BASE, expected_updated_at: T0 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.html, /Eins \(Browser\)\./);
  assert.match(r.json.html, /<li>a1, ergänzt<\/li>/);
  // Liste genau einmal, nicht in Teile zerrissen.
  assert.equal((r.json.html.match(/data-bid="b0000000000000b2"/g) || []).length, 1);
});
