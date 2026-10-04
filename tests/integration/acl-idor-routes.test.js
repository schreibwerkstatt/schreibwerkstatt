'use strict';
// Route-Tests für die Buch-ACL an Stellen, an denen der Client das Buch
// mitschickt, der Server es aber aus dem Objekt ableiten muss:
//
//   - POST /chat/session       — page_id eines fremden Buchs mit eigenem book_id
//   - POST /jobs/check         — dasselbe für den Seiten-Lektorat-Job
//   - POST /jobs/chat          — Alt-Session, deren Seite nicht im Session-Buch liegt
//   - POST /usage/page/track   — fremde Seite unter eigenem Buch
//   - POST /content/pages      — eigenes book_id + fremdes chapter_id
//   - GET  /plot, /ideen/counts — ein Nicht-ACL-Fehler beim Rollen-Lookup darf
//     nicht als „erlaubt" durchgehen (guardBook statt `return !sendACLError`)
//   - PATCH/DELETE /share/api/comments/:id — nur der Link-Owner
//   - GET  /jobs/:id           — fremde Jobs antworten wie unbekannte (404)
//
// Fährt die echten Router unter Express hoch; die Fake-Session liefert den User.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
let db;
let server;
let baseUrl;
let sessionUser = 'autor@test.dev';

const ME = 'autor@test.dev';
const OTHER = 'eindringling@test.dev';
const MY_BOOK = 9101;
const FOREIGN_BOOK = 9102;
const MY_PAGE = 91011;
const FOREIGN_PAGE = 91021;
const MY_CHAPTER = 9111;
const FOREIGN_CHAPTER = 9121;
const NOW = '2026-01-01T00:00:00.000Z';

function startServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use((req, _res, next) => {
      req.session = sessionUser ? { user: { email: sessionUser } } : {};
      next();
    });
    const jobs = express.Router();
    jobs.use(require('../../routes/jobs/lektorat').lektoratRouter);
    jobs.use(require('../../routes/jobs/chat').chatRouter);
    jobs.use(require('../../routes/jobs/rueckblick').rueckblickRouter);
    jobs.use(require('../../routes/jobs/shared/router').sharedRouter);
    app.use('/jobs', jobs);
    app.use('/chat', require('../../routes/chat'));
    app.use('/usage', require('../../routes/usage'));
    app.use('/content', require('../../routes/content'));
    app.use('/plot', require('../../routes/plot'));
    app.use('/ideen', require('../../routes/ideen'));
    const share = express.Router();
    require('../../routes/share/api').register(share);
    app.use('/share', share);
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
  await startServer();
});
test.after(() => {
  if (server) server.close();
  ctx.cleanup();
});

test.beforeEach(() => {
  sessionUser = ME;
  const { grantAccess } = require('../../db/book-access');
  for (const t of ['share_comments', 'share_links', 'chat_messages', 'chat_sessions', 'user_page_usage', 'book_access']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  ctx.dbSeed._wipeDb?.();
  db.prepare('DELETE FROM pages').run();
  db.prepare('DELETE FROM chapters').run();
  db.prepare('DELETE FROM books').run();
  const insBook = db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
  insBook.run(MY_BOOK, 'Mein Buch', NOW, NOW);
  insBook.run(FOREIGN_BOOK, 'Fremdes Buch', NOW, NOW);
  const insChap = db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, 0, ?)');
  insChap.run(MY_CHAPTER, MY_BOOK, 'Mein Kapitel', NOW);
  insChap.run(FOREIGN_CHAPTER, FOREIGN_BOOK, 'Fremdes Kapitel', NOW);
  const insPage = db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, updated_at, body_html)
                              VALUES (?, ?, ?, ?, 0, ?, ?)`);
  insPage.run(MY_PAGE, MY_BOOK, 'Meine Seite', MY_CHAPTER, NOW, '<p>Eigener Text.</p>');
  insPage.run(FOREIGN_PAGE, FOREIGN_BOOK, 'Geheime Seite', FOREIGN_CHAPTER, NOW, '<p>Geheimer Fremdtext.</p>');
  grantAccess(MY_BOOK, ME, 'editor', ME);
  grantAccess(FOREIGN_BOOK, OTHER, 'owner', OTHER);
});

// ── Seiten-Chat ─────────────────────────────────────────────────────────────

test('POST /chat/session: fremde Seite mit eigenem book_id → 403, keine Session', async () => {
  const r = await api('POST', '/chat/session', { book_id: MY_BOOK, page_id: FOREIGN_PAGE });
  assert.equal(r.status, 403);
  assert.equal(r.json.error_code, 'NO_BOOK_ACCESS');
  const n = db.prepare('SELECT COUNT(*) AS n FROM chat_sessions').get().n;
  assert.equal(n, 0);
});

test('POST /chat/session: eigene Seite → Session im Buch der Seite; GET liefert keinen Snapshot', async () => {
  // Client-book_id wird ignoriert — das Buch kommt aus der Seite.
  const r = await api('POST', '/chat/session', { book_id: FOREIGN_BOOK, page_id: MY_PAGE });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT book_id, page_id, opening_page_text FROM chat_sessions WHERE id = ?').get(r.json.id);
  assert.equal(row.book_id, MY_BOOK);
  assert.equal(row.page_id, MY_PAGE);
  assert.match(row.opening_page_text, /Eigener Text/);

  const g = await api('GET', `/chat/session/${r.json.id}`);
  assert.equal(g.status, 200);
  assert.equal(g.json.page_name, 'Meine Seite');
  assert.ok(!('opening_page_text' in g.json), 'Snapshot bleibt serverseitig');
});

test('POST /chat/session: fehlende/unbekannte Seite → 400/404', async () => {
  assert.equal((await api('POST', '/chat/session', { book_id: MY_BOOK })).json.error_code, 'PAGE_ID_REQUIRED');
  const r = await api('POST', '/chat/session', { page_id: 999999 });
  assert.equal(r.status, 404);
  assert.equal(r.json.error_code, 'PAGE_NOT_FOUND');
});

test('POST /chat/session: Orphan-Cleanup räumt leere Sessions älter als 60 s', async () => {
  const old = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const fresh = new Date(Date.now() - 10 * 1000).toISOString();
  const ins = db.prepare(`INSERT INTO chat_sessions (book_id, page_id, user_email, created_at, last_message_at)
                          VALUES (?, ?, ?, ?, ?)`);
  const oldId = ins.run(MY_BOOK, MY_PAGE, ME, old, old).lastInsertRowid;
  const freshId = ins.run(MY_BOOK, MY_PAGE, ME, fresh, fresh).lastInsertRowid;
  const r = await api('POST', '/chat/session', { page_id: MY_PAGE });
  assert.equal(r.status, 200);
  const ids = db.prepare('SELECT id FROM chat_sessions ORDER BY id').all().map(x => x.id);
  assert.ok(!ids.includes(Number(oldId)), 'alte leere Session entfernt');
  assert.ok(ids.includes(Number(freshId)), 'junge Session bleibt (Schonfrist)');
});

test('POST /jobs/chat: Session, deren Seite nicht im Session-Buch liegt → 404, kein Job', async () => {
  // Alt-Session aus der Zeit, als der Client das Buch bestimmte.
  const id = db.prepare(`INSERT INTO chat_sessions (book_id, page_id, user_email, created_at, last_message_at)
                         VALUES (?, ?, ?, ?, ?)`).run(MY_BOOK, FOREIGN_PAGE, ME, NOW, NOW).lastInsertRowid;
  const r = await api('POST', '/jobs/chat', { session_id: Number(id), message: 'Worum geht es?' });
  assert.equal(r.status, 404);
  assert.equal(r.json.error_code, 'SESSION_NOT_FOUND');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get().n, 0);
});

test('POST /jobs/chat: Buch-Session unter dem Seiten-Chat-Job → 404', async () => {
  const id = db.prepare(`INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at)
                         VALUES (?, 'book', ?, ?, ?)`).run(MY_BOOK, ME, NOW, NOW).lastInsertRowid;
  const r = await api('POST', '/jobs/chat', { session_id: Number(id), message: 'Hallo' });
  assert.equal(r.status, 404);
});

// ── Seiten-Lektorat ─────────────────────────────────────────────────────────

test('POST /jobs/check: fremde Seite mit eigenem book_id → 403, kein Job', async () => {
  const before = ctx.shared.jobs.size;
  const r = await api('POST', '/jobs/check', { book_id: MY_BOOK, page_id: FOREIGN_PAGE, page_name: 'x' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error_code, 'NO_BOOK_ACCESS');
  assert.equal(ctx.shared.jobs.size, before);
});

test('POST /jobs/check: eigene Seite → Job im Buch der Seite', async () => {
  const r = await api('POST', '/jobs/check', { book_id: FOREIGN_BOOK, page_id: MY_PAGE });
  assert.equal(r.status, 200);
  const job = ctx.shared.jobs.get(r.json.jobId);
  assert.equal(job.bookId, String(MY_BOOK));
  assert.equal(job.dedupId, String(MY_PAGE));
  // Job ohne Mock-Handler auslaufen lassen, damit er nicht in den nächsten Test läuft.
  await waitForJob(ctx.shared, r.json.jobId);
});

test('GET /jobs/:id: eigener Job lesbar, fremder Job → 404', async () => {
  const r = await api('POST', '/jobs/check', { page_id: MY_PAGE });
  assert.equal(r.status, 200);
  const mine = await api('GET', `/jobs/${r.json.jobId}`);
  assert.equal(mine.status, 200);
  sessionUser = OTHER;
  const foreign = await api('GET', `/jobs/${r.json.jobId}`);
  assert.equal(foreign.status, 404);
  assert.equal(foreign.json.error_code, 'JOB_NOT_FOUND');
  sessionUser = ME;
  await waitForJob(ctx.shared, r.json.jobId);
});

// ── Usage ───────────────────────────────────────────────────────────────────

test('POST /usage/page/track: fremde Seite → 403, eigene Seite unter ihrem Buch', async () => {
  const r = await api('POST', '/usage/page/track', { book_id: MY_BOOK, page_id: FOREIGN_PAGE });
  assert.equal(r.status, 403);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_page_usage').get().n, 0);

  const ok = await api('POST', '/usage/page/track', { book_id: FOREIGN_BOOK, page_id: MY_PAGE });
  assert.equal(ok.status, 200);
  const row = db.prepare('SELECT book_id FROM user_page_usage WHERE page_id = ?').get(MY_PAGE);
  assert.equal(row.book_id, MY_BOOK);
});

// ── Content ─────────────────────────────────────────────────────────────────

test('POST /content/pages: eigenes book_id + fremdes chapter_id → 400, keine Seite', async () => {
  const r = await api('POST', '/content/pages', { book_id: MY_BOOK, chapter_id: FOREIGN_CHAPTER, name: 'Neu' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'CHAPTER_NOT_IN_BOOK');
  const n = db.prepare("SELECT COUNT(*) AS n FROM pages WHERE page_name = 'Neu'").get().n;
  assert.equal(n, 0);
});

test('POST /content/pages: eigenes Kapitel → Seite angelegt', async () => {
  const r = await api('POST', '/content/pages', { book_id: MY_BOOK, chapter_id: MY_CHAPTER, name: 'Neu' });
  assert.equal(r.status, 200);
  assert.equal(r.json.chapter_id, MY_CHAPTER);
});

test('POST /content/chapters: fremdes parent_chapter_id → 400', async () => {
  const r = await api('POST', '/content/chapters', { book_id: MY_BOOK, name: 'Unter', parent_chapter_id: FOREIGN_CHAPTER });
  assert.equal(r.status, 400);
  assert.equal(r.json.error_code, 'CHAPTER_NOT_IN_BOOK');
});

// ── Guard: Nicht-ACL-Fehler ────────────────────────────────────────────────

// Der Rollen-Lookup scheitert mit einem DB-Fehler (Tabelle weg). Das darf nie
// als „erlaubt" gedeutet werden: der Request endet mit 500, nicht mit Daten.
async function withBrokenRoleLookup(fn) {
  db.prepare('ALTER TABLE book_access RENAME TO book_access_broken').run();
  try { return await fn(); }
  finally { db.prepare('ALTER TABLE book_access_broken RENAME TO book_access').run(); }
}

test('GET /plot: DB-Fehler im Rollen-Lookup → 500, kein Durchlass', async () => {
  const ok = await api('GET', `/plot?book_id=${MY_BOOK}`);
  assert.equal(ok.status, 200);
  const r = await withBrokenRoleLookup(() => api('GET', `/plot?book_id=${MY_BOOK}`));
  assert.equal(r.status, 500);
});

test('GET /ideen/counts: DB-Fehler im Rollen-Lookup → 500, kein Durchlass', async () => {
  const ok = await api('GET', `/ideen/counts?book_id=${MY_BOOK}`);
  assert.equal(ok.status, 200);
  const r = await withBrokenRoleLookup(() => api('GET', `/ideen/counts?book_id=${MY_BOOK}`));
  assert.equal(r.status, 500);
});

test('GET /plot, /ideen: fremdes Buch → 403, ohne Login → 401 NOT_LOGGED_IN', async () => {
  assert.equal((await api('GET', `/plot?book_id=${FOREIGN_BOOK}`)).status, 403);
  assert.equal((await api('GET', `/ideen/board?book_id=${FOREIGN_BOOK}`)).status, 403);
  sessionUser = null;
  const p = await api('GET', `/plot?book_id=${MY_BOOK}`);
  assert.equal(p.status, 401);
  assert.equal(p.json.error_code, 'NOT_LOGGED_IN');
  const i = await api('GET', `/ideen/board?book_id=${MY_BOOK}`);
  assert.equal(i.status, 401);
  assert.equal(i.json.error_code, 'NOT_LOGGED_IN');
});

test('POST /ideen ohne Anker → Buch-Idee; Zuordnen nur auf Stellen DIESES Buchs', async () => {
  sessionUser = ME;
  const created = await api('POST', '/ideen', { book_id: MY_BOOK, content: 'Einfall ohne Ort' });
  assert.equal(created.status, 200);
  assert.equal(created.json.page_id, null);
  assert.equal(created.json.chapter_id, null);
  const id = created.json.id;

  // Beide Anker zugleich bleibt ein Scope-Fehler.
  const both = await api('POST', '/ideen', { book_id: MY_BOOK, page_id: MY_PAGE, chapter_id: MY_CHAPTER, content: 'x' });
  assert.equal(both.json.error_code, 'INVALID_SCOPE');

  // Fremdes Kapitel → BOOK_MISMATCH, die Idee bleibt Buch-Idee.
  const foreign = await api('PATCH', `/ideen/${id}`, { chapter_id: FOREIGN_CHAPTER });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.json.error_code, 'BOOK_MISMATCH');

  const assigned = await api('PATCH', `/ideen/${id}`, { chapter_id: MY_CHAPTER });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.json.chapter_id, MY_CHAPTER);

  // Danach gilt within-kind: eine Kapitel-Idee wandert nicht auf eine Seite.
  const cross = await api('PATCH', `/ideen/${id}`, { page_id: MY_PAGE });
  assert.equal(cross.json.error_code, 'KIND_MISMATCH');
});

test('PUT /ideen/order: fremdes Buch → 403, fremde Idee kippt die ganze Reihenfolge', async () => {
  sessionUser = ME;
  const a = (await api('POST', '/ideen', { book_id: MY_BOOK, content: 'eins' })).json.id;
  const b = (await api('POST', '/ideen', { book_id: MY_BOOK, content: 'zwei' })).json.id;
  assert.equal((await api('PUT', '/ideen/order', { book_id: FOREIGN_BOOK, ids: [a, b] })).status, 403);

  sessionUser = OTHER;
  const fremd = (await api('POST', '/ideen', { book_id: FOREIGN_BOOK, content: 'fremd' })).json.id;
  sessionUser = ME;
  const mixed = await api('PUT', '/ideen/order', { book_id: MY_BOOK, ids: [b, fremd, a] });
  assert.equal(mixed.status, 400);
  assert.equal(mixed.json.error_code, 'ORDER_MISMATCH');

  assert.equal((await api('PUT', '/ideen/order', { book_id: MY_BOOK, ids: [a, a] })).json.error_code, 'ORDER_REQ');

  const ok = await api('PUT', '/ideen/order', { book_id: MY_BOOK, ids: [b, a] });
  assert.equal(ok.status, 200);
  const board = (await api('GET', `/ideen/board?book_id=${MY_BOOK}`)).json.ideen;
  const order = new Map(board.map(i => [i.id, i.sort_order]));
  assert.deepEqual([order.get(b), order.get(a)], [1, 2]);
});

// ── Share-API: Owner-Endpunkte ─────────────────────────────────────────────

function seedComment() {
  const shareLinks = require('../../db/share-links');
  const link = shareLinks.createShareLink({ kind: 'page', pageId: MY_PAGE, bookId: MY_BOOK, ownerEmail: ME });
  const c = shareLinks.insertComment({ token: link.token, readerName: 'Leser', body: 'Schöner Absatz.' });
  return c.id;
}
const commentExists = (id) => !!db.prepare('SELECT 1 FROM share_comments WHERE id = ?').get(id);

test('PATCH /share/api/comments/:id/resolve: nur der Link-Owner', async () => {
  const id = seedComment();
  sessionUser = OTHER;
  const foreign = await api('PATCH', `/share/api/comments/${id}/resolve`, { resolved: true });
  assert.equal(foreign.status, 404);
  assert.equal(db.prepare('SELECT resolved_at FROM share_comments WHERE id = ?').get(id).resolved_at, null);

  sessionUser = null;
  const anon = await api('PATCH', `/share/api/comments/${id}/resolve`, { resolved: true });
  assert.equal(anon.status, 401);
  assert.equal(anon.json.error_code, 'NOT_LOGGED_IN');

  sessionUser = ME;
  const own = await api('PATCH', `/share/api/comments/${id}/resolve`, { resolved: true });
  assert.equal(own.status, 200);
  assert.ok(db.prepare('SELECT resolved_at FROM share_comments WHERE id = ?').get(id).resolved_at);
});

test('DELETE /share/api/comments/:id: nur der Link-Owner', async () => {
  const id = seedComment();
  sessionUser = OTHER;
  assert.equal((await api('DELETE', `/share/api/comments/${id}`)).status, 404);
  assert.ok(commentExists(id));

  sessionUser = null;
  assert.equal((await api('DELETE', `/share/api/comments/${id}`)).status, 401);
  assert.ok(commentExists(id));

  sessionUser = ME;
  assert.equal((await api('DELETE', `/share/api/comments/${id}`)).status, 200);
  assert.ok(!commentExists(id));
});

// ── startBookJob (routes/jobs/shared/start-job.js) ─────────────────────────

test('startBookJob: 400 ohne book_id, 403 fremdes Buch, sonst Job mit String-Dedup-ID', async () => {
  const bad = await api('POST', '/jobs/rueckblick', { zeitraum: '2026' });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error_code, 'BOOK_ID_REQUIRED');

  const before = ctx.shared.jobs.size;
  const foreign = await api('POST', '/jobs/rueckblick', { book_id: FOREIGN_BOOK, zeitraum: '2026' });
  assert.equal(foreign.status, 403);
  assert.equal(ctx.shared.jobs.size, before);

  const ok = await api('POST', '/jobs/rueckblick', { book_id: MY_BOOK, zeitraum: '2026' });
  assert.equal(ok.status, 200);
  const job = ctx.shared.jobs.get(ok.json.jobId);
  assert.equal(job.type, 'rueckblick');
  assert.equal(job.bookId, String(MY_BOOK));
  assert.equal(job.dedupId, `${MY_BOOK}:2026`);
  await waitForJob(ctx.shared, ok.json.jobId);
});

// ── Seiten-Chat: Vorschlags-Status, Nachrichtentyp, Session-Liste ───────────

function seedPageChat(email = ME, vorschlaege = [{ original: 'Eigener', ersatz: 'Mein' }]) {
  const sid = db.prepare(`INSERT INTO chat_sessions (book_id, page_id, kind, user_email, created_at, last_message_at)
                          VALUES (?, ?, 'page', ?, ?, ?)`).run(MY_BOOK, MY_PAGE, email, NOW, NOW).lastInsertRowid;
  const mid = db.prepare(`INSERT INTO chat_messages (session_id, role, content, vorschlaege, created_at) VALUES (?, 'assistant', 'A', ?, ?)`)
    .run(sid, JSON.stringify(vorschlaege), NOW).lastInsertRowid;
  return { sid, mid };
}
const vorschlagOf = (mid) => JSON.parse(db.prepare('SELECT vorschlaege FROM chat_messages WHERE id = ?').get(mid).vorschlaege)[0];

test('PATCH /chat/message/:id/vorschlag/:idx/status: verwerfen ↔ öffnen, übernommen hebt verworfen auf', async () => {
  const { mid } = seedPageChat();
  assert.equal((await api('PATCH', `/chat/message/${mid}/vorschlag/0/status`, { status: 'discarded' })).status, 200);
  assert.equal(vorschlagOf(mid).status, 'discarded');
  assert.equal((await api('PATCH', `/chat/message/${mid}/vorschlag/0/status`, { status: null })).status, 200);
  assert.equal(vorschlagOf(mid).status, undefined);

  await api('PATCH', `/chat/message/${mid}/vorschlag/0/status`, { status: 'discarded' });
  assert.equal((await api('PATCH', `/chat/message/${mid}/vorschlag/0/applied`, {})).status, 200);
  const v = vorschlagOf(mid);
  assert.equal(v.applied, true);
  assert.equal(v.status, undefined, 'Übernehmen hebt „verworfen" auf');
  const conflict = await api('PATCH', `/chat/message/${mid}/vorschlag/0/status`, { status: 'discarded' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error_code, 'VORSCHLAG_ALREADY_APPLIED');

  assert.equal((await api('PATCH', `/chat/message/${mid}/vorschlag/0/applied`, { applied: false })).status, 200);
  assert.equal(vorschlagOf(mid).applied, undefined, 'Rückgängig nimmt applied zurück');
});

test('PATCH …/vorschlag/:idx/status: ungültiger Status 400, fremde Nachricht 404', async () => {
  const { mid } = seedPageChat(OTHER);
  assert.equal((await api('PATCH', `/chat/message/${mid}/vorschlag/0/status`, { status: 'applied' })).status, 400);
  const r = await api('PATCH', `/chat/message/${mid}/vorschlag/0/status`, { status: 'discarded' });
  assert.equal(r.status, 404);
  assert.equal(vorschlagOf(mid).status, undefined);
});

test('POST /jobs/chat: message ohne String-Typ → 400 statt 500', async () => {
  const { sid } = seedPageChat();
  for (const message of [42, { x: 1 }, ['a'], null]) {
    const r = await api('POST', '/jobs/chat', { session_id: sid, message });
    assert.equal(r.status, 400, `message=${JSON.stringify(message)}`);
    assert.equal(r.json.error_code, 'SESSION_ID_MSG_REQUIRED');
  }
});

test('GET /chat/sessions/:page_id: vollständige Liste (kein 20er-Deckel), Preview gekappt', async () => {
  for (let i = 0; i < 25; i++) seedPageChat();
  db.prepare(`UPDATE chat_messages SET content = ?`).run('x'.repeat(500));
  const r = await api('GET', `/chat/sessions/${MY_PAGE}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 25);
  assert.ok(r.json.every(s => s.preview.length <= 200));
});
