'use strict';
// Undo eines Löschens im Ideen- und im Recherche-Board (lib/restore-fields.js):
// der Client legt den Eintrag per POST neu an und schickt im Feld `restore` den
// Stand aus seinem Snapshot mit. Geprüft am echten Router:
//   * Anlegedatum, Status samt Zeitpunkt und Rang bzw. Anheften/Archiv kommen
//     aus dem Snapshot, nicht «heute».
//   * Unplausible Zeitstempel (Zukunft, kein ISO, Status vor dem Anlegen) → 400.
//   * Ohne `restore` bleibt alles beim normalen Anlegen.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

let ctx, db, server, baseUrl;
const ME = 'autor@test.dev';
const BOOK = 9501;
const CHAPTER = 9511;
const NOW = '2026-01-01T00:00:00.000Z';
const CREATED = '2025-03-04T05:06:07.000Z';
const STATUS_AT = '2025-04-01T08:00:00.000Z';

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => { req.session = { user: { email: ME } }; next(); });
    app.use('/ideen', require('../../routes/ideen'));
    app.use('/research', require('../../routes/research'));
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
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
  if (!db.prepare('SELECT 1 FROM app_users WHERE email = ?').get(ME)) {
    require('../../db/app-users').createUser({ email: ME, displayName: 'Autor' });
  }
  await startServer();
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });
test.beforeEach(() => {
  for (const t of ['idea_links', 'ideen', 'research_item_tags', 'research_item_links', 'research_item_urls',
    'research_items', 'book_settings', 'book_access', 'chapters', 'books']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(BOOK, 'Buch', NOW, NOW);
  db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, 0, ?)')
    .run(CHAPTER, BOOK, 'Kapitel', NOW);
  require('../../db/book-access').grantAccess(BOOK, ME, 'editor', ME);
});

test('Idee: restore übernimmt Anlegedatum, Stufe, Stufen-Zeitpunkt und Rang', async () => {
  const r = await api('POST', '/ideen', {
    book_id: BOOK, chapter_id: CHAPTER, content: 'Zurück',
    restore: { created_at: CREATED, status: 'erledigt', status_at: STATUS_AT, sort_order: 3 },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.created_at, CREATED);
  assert.equal(r.json.status, 'erledigt');
  assert.equal(r.json.status_at, STATUS_AT);
  assert.equal(r.json.sort_order, 3);
});

test('Idee: restore in eine inzwischen abgeschaltete Stufe ist erlaubt', async () => {
  await api('PUT', '/ideen/stages', { book_id: BOOK, stages: ['offen', 'erledigt'] });
  const r = await api('POST', '/ideen', {
    book_id: BOOK, content: 'War in Arbeit', restore: { created_at: CREATED, status: 'in_arbeit' },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.status, 'in_arbeit');
});

test('Idee: ohne restore bleibt es ein normales Anlegen', async () => {
  const before = Date.now();
  const r = await api('POST', '/ideen', { book_id: BOOK, content: 'Neu' });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'offen');
  assert.ok(Date.parse(r.json.created_at) >= before - 1000, 'created_at ist jetzt');
});

test('Idee: unplausibler Snapshot → 400, nichts angelegt', async () => {
  const future = new Date(Date.now() + 24 * 3600e3).toISOString();
  const cases = [
    [{ created_at: future }, 'INVALID_RESTORE'],
    [{ created_at: 'gestern' }, 'INVALID_RESTORE'],
    [{ created_at: CREATED, status_at: '2024-01-01T00:00:00.000Z' }, 'INVALID_RESTORE'],
    [{ created_at: CREATED, status: 'quatsch' }, 'INVALID_STATUS'],
    [{ created_at: CREATED, sort_order: -1 }, 'INVALID_RESTORE'],
    ['2025-01-01', 'INVALID_RESTORE'],
  ];
  for (const [restore, code] of cases) {
    const r = await api('POST', '/ideen', { book_id: BOOK, content: 'X', restore });
    assert.equal(r.status, 400, JSON.stringify(restore));
    assert.equal(r.json.error_code, code, JSON.stringify(restore));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ideen').get().n, 0);
});

test('Fundstück: restore übernimmt Anlegedatum, Status, Anheften und Archiv', async () => {
  const r = await api('POST', '/research', {
    book_id: BOOK, title: 'Zurück',
    restore: { created_at: CREATED, status: 'eingearbeitet', status_at: STATUS_AT, pinned: true, archived: true },
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const row = db.prepare('SELECT * FROM research_items WHERE id = ?').get(r.json.id);
  assert.equal(row.created_at, CREATED);
  assert.equal(row.status, 'eingearbeitet');
  assert.equal(row.status_at, STATUS_AT);
  assert.equal(row.status_by, ME, 'Status-Zuschreibung = wer wiederherstellt');
  assert.equal(row.pinned, 1);
  assert.equal(row.archived, 1);
});

test('Fundstück: unplausibler Snapshot → 400, nichts angelegt', async () => {
  const future = new Date(Date.now() + 24 * 3600e3).toISOString();
  for (const restore of [{ created_at: future }, { created_at: CREATED, pinned: 'ja' }]) {
    const r = await api('POST', '/research', { book_id: BOOK, title: 'X', restore });
    assert.equal(r.status, 400, JSON.stringify(restore));
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM research_items').get().n, 0);
});
