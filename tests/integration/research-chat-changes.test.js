'use strict';
// Integration: Änderungsvorschläge des Recherche-Chats übernehmen
// (routes/research-chat-changes.js über routes/research.js):
//   POST /research/chat-proposal/apply — ergänzen, Status mit Beleg, archivieren,
//   zusammenführen; Stale-/Beleg-/Doppelklick-Schutz; Besitz + ACL
//   PATCH /research/chat-proposal — verwerfen/wieder öffnen

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

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, opts);
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  const researchRouter = require('../../routes/research');
  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: sessionUser } }; next(); });
  app.use('/research', researchRouter);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});
test.beforeEach(() => {
  sessionUser = 'autor@test.dev';
  for (const t of ['chat_messages', 'chat_sessions', 'idea_links', 'ideen', 'research_item_findings', 'research_item_links',
    'research_item_tags', 'research_item_urls', 'research_items', 'pages', 'chapters', 'book_access', 'books']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
});

function seedBook(bookId, user = 'autor@test.dev') {
  db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Testbuch', ?, ?)").run(bookId, NOW, NOW);
  require('../../db/book-access').grantAccess(bookId, user, 'editor', user);
  return db.prepare(
    "INSERT INTO pages (book_id, page_name, body_html, position, updated_at) VALUES (?, 'Ankunft', ?, 0, ?)"
  ).run(bookId, '<p>Der Zug fuhr um 7 Uhr in Olten ein.</p>', NOW).lastInsertRowid;
}

async function item(bookId, fields) {
  const { status, json } = await api('POST', '/research', { book_id: bookId, title: 'Notiz', ...fields });
  assert.equal(status, 200, JSON.stringify(json));
  return json;
}

function message(bookId, proposals, user = 'autor@test.dev') {
  const sid = db.prepare(
    "INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at) VALUES (?, 'research', ?, ?, ?)"
  ).run(bookId, user, NOW, NOW).lastInsertRowid;
  return db.prepare(
    "INSERT INTO chat_messages (session_id, role, content, context_info, created_at) VALUES (?, 'assistant', 'A', ?, ?)"
  ).run(sid, JSON.stringify({ mode: 'research', proposals }), NOW).lastInsertRowid;
}
const stored = (mid) => JSON.parse(db.prepare('SELECT context_info FROM chat_messages WHERE id = ?').get(mid).context_info).proposals;
const apply = (mid, index, extra = {}) => api('POST', '/research/chat-proposal/apply', { message_id: mid, index, ...extra });

test('ergänzen: Text angehängt, nur neue URLs/Tags, Status festgehalten; zweiter Klick → 409', async () => {
  const BOOK = 9101;
  seedBook(BOOK);
  const it = await item(BOOK, { body: 'Erster Zug 7 Uhr', urls: ['https://example.org/a'], tags: ['Bahn'] });
  const mid = message(BOOK, [
    { kind: 'note', title: 'neues Fundstück davor' },
    {
      type: 'research_update', item_id: it.id,
      fields: { append: 'Ab 1902 elektrisch.', tags: ['Olten'] },
      urls: [{ url: 'https://example.org/b', label: 'B', verified: true }, { url: 'https://example.org/c', verified: false }],
      before: { title: 'Notiz', body: 'Erster Zug 7 Uhr', source: '', status: 'offen' },
    },
  ]);
  const r = await apply(mid, 1, { edits: { urls: ['https://example.org/b'] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.item.body, 'Erster Zug 7 Uhr\n\nAb 1902 elektrisch.');
  assert.deepEqual(r.json.item.urls.map(u => u.url), ['https://example.org/a', 'https://example.org/b'], 'weggelassene URL bleibt draussen');
  assert.deepEqual(r.json.item.tags.sort(), ['Bahn', 'Olten']);
  assert.equal(stored(mid)[1].applied_id, it.id);
  assert.ok(stored(mid)[1].applied_at);
  const again = await apply(mid, 1);
  assert.equal(again.status, 409);
  assert.equal(again.json.error_code, 'PROPOSAL_ALREADY_APPLIED');
  // Das neue Fundstück am Index 0 läuft nicht über diese Route.
  assert.equal((await apply(mid, 0)).status, 404);
});

test('umschreiben: bearbeiteter Eintrag → 409 PROPOSAL_STALE, nichts geschrieben', async () => {
  const BOOK = 9102;
  seedBook(BOOK);
  const it = await item(BOOK, { body: 'alt' });
  const mid = message(BOOK, [{ type: 'research_update', item_id: it.id, fields: { body: 'neu' }, before: { title: 'Notiz', body: 'alt' } }]);
  await api('PATCH', `/research/${it.id}`, { body: 'vom User geändert' });
  const r = await apply(mid, 0);
  assert.equal(r.status, 409);
  assert.equal(r.json.error_code, 'PROPOSAL_STALE');
  assert.equal(db.prepare('SELECT body FROM research_items WHERE id = ?').get(it.id).body, 'vom User geändert');
  assert.equal(stored(mid)[0].applied_at, undefined);
});

test('eingearbeitet: Beleg neu geprüft, Stelle wird verknüpft; fehlender Beleg nur mit ignore_beleg', async () => {
  const BOOK = 9103;
  const pageId = seedBook(BOOK);
  const it = await item(BOOK, { body: 'Zug' });
  const proposal = {
    type: 'research_update', item_id: it.id, fields: { status: 'eingearbeitet' },
    beleg: { text: 'um 7 Uhr in Olten', page_id: pageId }, before: { title: 'Notiz', body: 'Zug', status: 'offen' },
  };
  const mid = message(BOOK, [proposal, { ...proposal }]);
  const ok = await apply(mid, 0);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.item.status, 'eingearbeitet');
  assert.deepEqual(ok.json.item.links.map(l => [l.target_kind, l.target_id]), [['page', pageId]]);

  db.prepare('UPDATE research_items SET status = ? WHERE id = ?').run('offen', it.id);
  db.prepare('UPDATE pages SET body_html = ? WHERE page_id = ?').run('<p>Ganz anders.</p>', pageId);
  const missing = await apply(mid, 1);
  assert.equal(missing.status, 409);
  assert.equal(missing.json.error_code, 'BELEG_MISSING');
  const forced = await apply(mid, 1, { ignore_beleg: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.json.item.status, 'eingearbeitet');
});

test('archivieren', async () => {
  const BOOK = 9104;
  seedBook(BOOK);
  const it = await item(BOOK, {});
  const mid = message(BOOK, [{ type: 'research_archive', item_id: it.id }]);
  const r = await apply(mid, 0);
  assert.equal(r.status, 200);
  assert.equal(r.json.item.archived, 1);
});

test('zusammenführen: URLs/Tags/Verknüpfungen/Ideen ziehen um, B ist gelöscht', async () => {
  const BOOK = 9105;
  const pageId = seedBook(BOOK);
  const a = await item(BOOK, { title: 'A', body: 'Text A', urls: ['https://example.org/a'], tags: ['x'] });
  const b = await item(BOOK, { allow_duplicate: true, title: 'B', body: 'Text B', source: 'Archiv', urls: ['https://www.example.org/a', 'https://example.org/b'], tags: ['X', 'y'] });
  await api('POST', `/research/${b.id}/links`, { target_kind: 'page', target_id: pageId });
  const ideaId = db.prepare("INSERT INTO ideen (book_id, user_email, content, created_at, updated_at) VALUES (?, 'autor@test.dev', 'I', ?, ?)")
    .run(BOOK, NOW, NOW).lastInsertRowid;
  db.prepare("INSERT INTO idea_links (idea_id, target_kind, research_id, created_at) VALUES (?, 'research', ?, ?)").run(ideaId, b.id, NOW);
  const mid = message(BOOK, [{ type: 'research_merge', item_id: a.id, merge_item_id: b.id, fields: {}, before: { title: 'A', body: 'Text A' } }]);
  const r = await apply(mid, 0);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.merged_id, b.id);
  assert.equal(r.json.item.body, 'Text A\n\nText B');
  assert.equal(r.json.item.source, 'Archiv');
  assert.deepEqual(r.json.item.urls.map(u => u.url), ['https://example.org/a', 'https://example.org/b'], 'normalisiert gleiche URL einmal');
  assert.deepEqual(r.json.item.tags.sort(), ['x', 'y']);
  assert.deepEqual(r.json.item.links.map(l => l.target_id), [pageId]);
  assert.equal(db.prepare('SELECT research_id FROM idea_links WHERE idea_id = ?').get(ideaId).research_id, a.id);
  assert.equal(db.prepare('SELECT 1 FROM research_items WHERE id = ?').get(b.id), undefined);
});

test('zusammenführen: Medien-Eintrag als B abgelehnt, fehlendes B → 404', async () => {
  const BOOK = 9106;
  seedBook(BOOK);
  const a = await item(BOOK, {});
  const img = db.prepare("INSERT INTO research_items (book_id, user_email, kind, title, created_at, updated_at) VALUES (?, 'autor@test.dev', 'image', 'Bild', ?, ?)")
    .run(BOOK, NOW, NOW).lastInsertRowid;
  const mid = message(BOOK, [
    { type: 'research_merge', item_id: a.id, merge_item_id: img, fields: {}, before: {} },
    { type: 'research_merge', item_id: a.id, merge_item_id: 999999, fields: {}, before: {} },
  ]);
  const media = await apply(mid, 0);
  assert.equal(media.status, 400);
  assert.equal(media.json.error_code, 'MERGE_MEDIA');
  assert.equal((await apply(mid, 1)).status, 404);
});

test('verwerfen + wieder öffnen über PATCH /research/chat-proposal; verworfen nicht übernehmbar', async () => {
  const BOOK = 9107;
  seedBook(BOOK);
  const it = await item(BOOK, {});
  const mid = message(BOOK, [{ type: 'research_archive', item_id: it.id }, { kind: 'note', title: 'neu' }]);
  const d = await api('PATCH', '/research/chat-proposal', { message_id: mid, index: 0, action: 'discarded' });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.equal(stored(mid)[0].status, 'discarded');
  assert.equal((await apply(mid, 0)).json.error_code, 'PROPOSAL_DISCARDED');
  await api('PATCH', '/research/chat-proposal', { message_id: mid, index: 0, action: 'reopen' });
  assert.equal((await apply(mid, 0)).status, 200);
  // Neue Fundstücke kennen kein Verwerfen.
  assert.equal((await api('PATCH', '/research/chat-proposal', { message_id: mid, index: 1, action: 'discarded' })).status, 404);
});

test('fremde Session → 404, ohne Schreibrecht → 403', async () => {
  const BOOK = 9108;
  seedBook(BOOK);
  db.prepare("INSERT OR IGNORE INTO app_users (email) VALUES ('leser@test.dev')").run();
  require('../../db/book-access').grantAccess(BOOK, 'leser@test.dev', 'viewer', 'autor@test.dev');
  const it = await item(BOOK, {});
  const mid = message(BOOK, [{ type: 'research_archive', item_id: it.id }]);
  sessionUser = 'fremd@test.dev';
  assert.equal((await apply(mid, 0)).status, 404);
  sessionUser = 'leser@test.dev';
  const own = message(BOOK, [{ type: 'research_archive', item_id: it.id }], 'leser@test.dev');
  assert.equal((await apply(own, 0)).status, 403);
});
