'use strict';
// Route-Tests der Rückblick-History (routes/history/reviews.js):
//   - GET  /history/rueckblick/:book_id     — alle Läufe als Metadaten (ohne Limit,
//                                             ohne result_json) + current_model
//   - GET  /history/rueckblick-entry/:id    — Ergebnis lazy, nur eigene Zeilen
//   - GET  /history/rueckblick-search/:book_id?q= — Inhaltssuche, keine JSON-Schlüssel
//   - DELETE /history/rueckblick/:id        — fremde Zeile bleibt
//   - GET  /history/rueckblick-coverage/:book_id — days + newest je Bucket
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
let sessionUser = 'autor@test.dev';

const ME = 'autor@test.dev';
const OTHER = 'mitleser@test.dev';
const BOOK = 9301;
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

async function api(method, path) {
  const res = await fetch(`${baseUrl}${path}`, { method });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

const result = (summary, extra = {}) => JSON.stringify({
  themen: [{ label: 'Garten', haeufigkeit: 1, belege: ['2024-03-04'] }],
  personen: [], orte: [], bemerkenswerteTage: [], zusammenfassung: summary, ...extra,
});

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
  for (const t of ['tagebuch_rueckblicke', 'book_access']) db.prepare(`DELETE FROM ${t}`).run();
  ctx.dbSeed._wipeDb?.();
  db.prepare('DELETE FROM pages').run();
  db.prepare('DELETE FROM chapters').run();
  db.prepare('DELETE FROM books').run();
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(BOOK, 'Tagebuch', NOW, NOW);
  const insPage = db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, updated_at, body_html)
                              VALUES (?, ?, ?, NULL, 0, ?, '<p>x</p>')`);
  insPage.run(93011, BOOK, '2024-03-04', '2024-03-05T10:00:00.000Z');
  insPage.run(93012, BOOK, '2024-03-20', '2024-03-21T10:00:00.000Z');
  grantAccess(BOOK, ME, 'owner', ME);
  grantAccess(BOOK, OTHER, 'editor', ME);
  const ins = db.prepare(`INSERT INTO tagebuch_rueckblicke (book_id, user_email, zeitraum, result_json, model, entry_count, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`);
  // 25 eigene Läufe — mehr als das frühere Listen-Limit von 20.
  for (let i = 0; i < 25; i++) {
    const y = 2000 + i;
    ins.run(BOOK, ME, `${y}-03`, result(i === 3 ? 'Ein Monat voller Wanderungen.' : `Monat ${y}.`), 'claude-opus-5-5', 2, `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`);
  }
  ins.run(BOOK, OTHER, '2024-03', result('Fremder Rückblick mit Wanderungen.'), 'claude-opus-5-5', 2, NOW);
});

test('GET /history/rueckblick/:book_id: alle eigenen Läufe, nur Metadaten, current_model', async () => {
  const r = await api('GET', `/history/rueckblick/${BOOK}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.entries.length, 25, 'kein 20er-Limit mehr');
  assert.ok(r.json.entries.every(e => !('result_json' in e)), 'Liste ohne Ergebnis');
  assert.equal(r.json.entries[0].zeitraum, '2024-03', 'jüngster zuerst');
  assert.equal(typeof r.json.current_model, 'string');
  assert.ok(r.json.current_model.length > 0);
});

test('GET /history/rueckblick-entry/:id: eigenes Ergebnis ja, fremdes 404', async () => {
  const own = db.prepare('SELECT id FROM tagebuch_rueckblicke WHERE user_email = ? AND zeitraum = ?').get(ME, '2003-03');
  const r = await api('GET', `/history/rueckblick-entry/${own.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.result_json.zusammenfassung, 'Ein Monat voller Wanderungen.');

  const foreign = db.prepare('SELECT id FROM tagebuch_rueckblicke WHERE user_email = ?').get(OTHER);
  const f = await api('GET', `/history/rueckblick-entry/${foreign.id}`);
  assert.equal(f.status, 404);
  assert.equal(f.json.error_code, 'NOT_FOUND');
});

test('GET /history/rueckblick-search: Inhalt eigener Läufe, keine JSON-Schlüssel', async () => {
  const r = await api('GET', `/history/rueckblick-search/${BOOK}?q=wanderung`);
  assert.equal(r.status, 200);
  const own = db.prepare('SELECT id FROM tagebuch_rueckblicke WHERE user_email = ? AND zeitraum = ?').get(ME, '2003-03');
  assert.deepEqual(r.json.ids, [own.id], 'fremder Treffer bleibt aussen vor');
  const keys = await api('GET', `/history/rueckblick-search/${BOOK}?q=zusammenfassung`);
  assert.deepEqual(keys.json.ids, []);
  const label = await api('GET', `/history/rueckblick-search/${BOOK}?q=garten`);
  assert.equal(label.json.ids.length, 25);
});

test('DELETE /history/rueckblick/:id: fremde Zeile bleibt bestehen', async () => {
  const foreign = db.prepare('SELECT id FROM tagebuch_rueckblicke WHERE user_email = ?').get(OTHER);
  const r = await api('DELETE', `/history/rueckblick/${foreign.id}`);
  assert.equal(r.status, 200);
  assert.ok(db.prepare('SELECT id FROM tagebuch_rueckblicke WHERE id = ?').get(foreign.id));
});

test('GET /history/rueckblick-coverage: days + newest je Bucket', async () => {
  const r = await api('GET', `/history/rueckblick-coverage/${BOOK}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.days, { '2024-03-04': 93011, '2024-03-20': 93012 });
  assert.equal(r.json.months['2024-03'].entries, 2);
  assert.equal(r.json.months['2024-03'].newest, Date.parse('2024-03-21T10:00:00.000Z'));
  assert.equal(r.json.months['2024-03'].rueckblick.id,
    db.prepare('SELECT id FROM tagebuch_rueckblicke WHERE user_email = ? AND zeitraum = ?').get(ME, '2024-03').id);
});
