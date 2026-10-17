'use strict';
// Share-Links und Downloads nach Entzug des Buchzugriffs.
//
//   - DELETE/PUT /books/:id/access/:email und POST /books/:id/share (Herabstufung)
//     widerrufen die Links des Betroffenen, sobald er unter die Share-Rolle faellt
//   - Defense in depth: ein Link, dessen Ersteller die Rolle verloren hat, ist fuer
//     Leser tot (Reader 410, Kommentar 410, Fazit 404), auch ohne revoked_at
//   - PATCH /share/api/links/:token verlangt die Share-Rolle auf dem Buch
//   - Buch-Owner sieht fremde Links seines Buchs und darf sie widerrufen
//   - Fazit-POST ist gedrosselt; share_views waechst nicht pro Reload
//   - Export-Downloads, Rueckblick-Eintrag, Chat-Session, Quelle mit book_id:
//     Buch-ACL wird beim Lesen erneut geprueft
//
// Faehrt die echten Router unter Express hoch; die Fake-Session liefert den User.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.DB_PATH = path.join(os.tmpdir(), `share-access-revocation-${process.pid}-${Date.now()}.db`);
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const express = require('express');
const { db } = require('../../db/connection');
require('../../db/migrations').runMigrations();
const appUsers = require('../../db/app-users');
const bookAccess = require('../../db/book-access');
const sl = require('../../db/share-links');
const rateLimit = require('../../lib/share-ratelimit');

const OWNER = 'owner@revoke.test';
const EDITOR = 'editor@revoke.test';
const STRANGER = 'fremd@revoke.test';
const BOOK = 8801;
const OTHER_BOOK = 8802;
const PAGE = 88011;
const NOW = '2026-01-01T00:00:00.000Z';

let sessionUser = OWNER;
let server;
let baseUrl;

function startServer() {
  const app = express();
  app.use((req, _res, next) => {
    req.session = sessionUser ? { user: { email: sessionUser } } : {};
    next();
  });
  app.use('/share', require('../../routes/share'));
  app.use('/books', require('../../routes/book-access'));
  const jobs = express.Router();
  jobs.use(require('../../routes/jobs/docx-export').docxExportRouter);
  jobs.use(require('../../routes/jobs/epub-export').epubExportRouter);
  jobs.use(require('../../routes/jobs/finetune-export').finetuneExportRouter);
  app.use('/jobs', jobs);
  const history = express.Router();
  require('../../routes/history/reviews').register(history);
  app.use('/history', history);
  app.use('/chat', require('../../routes/chat'));
  app.use('/sources', require('../../routes/sources'));
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

async function api(method, p, body, as = sessionUser) {
  sessionUser = as;
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    redirect: 'manual',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, json, text };
}

test.before(async () => {
  for (const [email, name] of [[OWNER, 'Olga Owner'], [EDITOR, 'Eddi Editor'], [STRANGER, 'Fremd']]) {
    if (!appUsers.getUser(email)) appUsers.createUser({ email, displayName: name });
  }
  const insBook = db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
  insBook.run(BOOK, 'Buch', NOW, NOW);
  insBook.run(OTHER_BOOK, 'Anderes Buch', NOW, NOW);
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, position, updated_at, body_html)
              VALUES (?, ?, ?, 0, ?, ?)`).run(PAGE, BOOK, 'Abschnitt', NOW, '<p>GEHEIMTEXT</p>');
  await startServer();
});
test.after(() => { server?.close(); });

test.beforeEach(() => {
  sessionUser = OWNER;
  rateLimit._resetAll();
  for (const t of ['share_feedback', 'share_comments', 'share_views', 'share_links', 'book_access']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  bookAccess.grantAccess(BOOK, OWNER, 'owner', OWNER);
  bookAccess.grantAccess(BOOK, EDITOR, 'editor', OWNER);
  bookAccess.grantAccess(OTHER_BOOK, STRANGER, 'owner', STRANGER);
});

function editorLink() {
  return sl.createShareLink({ kind: 'page', pageId: PAGE, bookId: BOOK, ownerEmail: EDITOR });
}
const revokedAt = (token) => sl.getShareLinkByToken(token).revoked_at;

// ── 1a: Entzug / Herabstufung widerruft ────────────────────────────────────

test('DELETE /books/:id/access/:email widerruft die Links des Entfernten', async () => {
  const mine = sl.createShareLink({ kind: 'book', bookId: BOOK, ownerEmail: OWNER });
  const link = editorLink();
  const r = await api('DELETE', `/books/${BOOK}/access/${encodeURIComponent(EDITOR)}`, null, OWNER);
  assert.equal(r.status, 200);
  assert.ok(revokedAt(link.token), 'Link des Entfernten ist widerrufen');
  assert.equal(revokedAt(mine.token), null, 'Links anderer bleiben');
});

test('PUT /books/:id/access/:email unter editor widerruft, editor bleibt aktiv', async () => {
  const link = editorLink();
  let r = await api('PUT', `/books/${BOOK}/access/${encodeURIComponent(EDITOR)}`, { role: 'editor' }, OWNER);
  assert.equal(r.status, 200);
  assert.equal(revokedAt(link.token), null, 'gleiche Rolle → Link bleibt');
  r = await api('PUT', `/books/${BOOK}/access/${encodeURIComponent(EDITOR)}`, { role: 'lektor' }, OWNER);
  assert.equal(r.status, 200);
  assert.ok(revokedAt(link.token), 'Herabstufung auf lektor → widerrufen');
});

test('POST /books/:id/share mit niedrigerer Rolle widerruft ebenfalls', async () => {
  const link = editorLink();
  const r = await api('POST', `/books/${BOOK}/share`, { email: EDITOR, role: 'viewer' }, OWNER);
  assert.equal(r.status, 200);
  assert.ok(revokedAt(link.token));
});

// ── 1b: Defense in depth (Rolle weg, revoked_at noch leer) ─────────────────

test('Ersteller ohne Buchrolle: Reader 410, Kommentar 410, Fazit 404, Threads 410', async () => {
  const link = editorLink();
  let r = await api('GET', `/share/${link.token}`, null, null);
  assert.equal(r.status, 200, 'mit Rolle lesbar');
  bookAccess.revokeAccess(BOOK, EDITOR); // direkt, ohne Route → revoked_at bleibt leer
  assert.equal(revokedAt(link.token), null);
  r = await api('GET', `/share/${link.token}`, null, null);
  assert.equal(r.status, 410);
  assert.doesNotMatch(r.text, /GEHEIMTEXT/);
  r = await api('POST', `/share/${link.token}/comment`, { body: 'hallo' }, null);
  assert.equal(r.status, 410);
  r = await api('POST', `/share/${link.token}/feedback`, { reader_token: 'abcdefgh12', rating: 4 }, null);
  assert.equal(r.status, 404);
  r = await api('GET', `/share/${link.token}/threads`, null, null);
  assert.equal(r.status, 410);
});

test('Ersteller nur noch lektor: Link gilt als widerrufen', async () => {
  const link = editorLink();
  bookAccess.grantAccess(BOOK, EDITOR, 'lektor', OWNER);
  const r = await api('GET', `/share/${link.token}`, null, null);
  assert.equal(r.status, 410);
});

// ── 1c: PATCH verlangt die Share-Rolle ─────────────────────────────────────

test('PATCH /share/api/links/:token: Ersteller ohne editor-Rolle → 403', async () => {
  const link = editorLink();
  let r = await api('PATCH', `/share/api/links/${link.token}`, { intro: 'neu' }, EDITOR);
  assert.equal(r.status, 200);
  bookAccess.grantAccess(BOOK, EDITOR, 'viewer', OWNER);
  r = await api('PATCH', `/share/api/links/${link.token}`, { intro: 'nochmal' }, EDITOR);
  assert.equal(r.status, 403);
  assert.equal(sl.getShareLinkByToken(link.token).intro, 'neu');
  r = await api('GET', `/share/api/links/${link.token}/comments`, null, EDITOR);
  assert.equal(r.status, 200, 'Lesen bleibt mit viewer');
  bookAccess.revokeAccess(BOOK, EDITOR);
  r = await api('GET', `/share/api/links/${link.token}/comments`, null, EDITOR);
  assert.equal(r.status, 403, 'ohne Buchzugriff keine Kommentare mehr');
});

// ── 1d: Buch-Owner sieht und widerruft fremde Links ────────────────────────

test('GET /share/api/links?book_id: Owner sieht alle Links mit Ersteller, Editor nur eigene', async () => {
  const own = sl.createShareLink({ kind: 'book', bookId: BOOK, ownerEmail: OWNER });
  const foreign = editorLink();
  let r = await api('GET', `/share/api/links?book_id=${BOOK}`, null, OWNER);
  assert.equal(r.status, 200);
  const byToken = Object.fromEntries(r.json.map(x => [x.token, x]));
  assert.equal(byToken[own.token].mine, true);
  assert.equal(byToken[foreign.token].mine, false);
  assert.equal(byToken[foreign.token].owner_email, EDITOR);
  assert.equal(byToken[foreign.token].owner_display_name, 'Eddi Editor');
  assert.equal(byToken[foreign.token].creator_access, true);

  r = await api('GET', `/share/api/links?book_id=${BOOK}`, null, EDITOR);
  assert.deepEqual(r.json.map(x => x.token), [foreign.token]);

  r = await api('GET', `/share/api/links?book_id=${BOOK}`, null, STRANGER);
  assert.equal(r.status, 403, 'ohne Buchzugriff keine Liste');
});

test('DELETE /share/api/links/:token: Buch-Owner widerruft fremden Link, Editor nicht', async () => {
  const ownerLink = sl.createShareLink({ kind: 'book', bookId: BOOK, ownerEmail: OWNER });
  const foreign = editorLink();
  let r = await api('DELETE', `/share/api/links/${ownerLink.token}`, null, EDITOR);
  assert.equal(r.status, 404, 'Editor darf fremden Link nicht widerrufen');
  assert.equal(revokedAt(ownerLink.token), null);
  r = await api('DELETE', `/share/api/links/${foreign.token}`, null, STRANGER);
  assert.equal(r.status, 404, 'Fremder ohne Buchrolle → 404');
  r = await api('DELETE', `/share/api/links/${foreign.token}`, null, OWNER);
  assert.equal(r.status, 200);
  assert.ok(revokedAt(foreign.token));
  r = await api('PATCH', `/share/api/links/${ownerLink.token}`, { intro: 'x' }, EDITOR);
  assert.equal(r.status, 404, 'Bearbeiten bleibt beim Ersteller');
});

// ── 4: Fazit-Drossel + View-Dedupe ─────────────────────────────────────────

test('POST /share/:token/feedback ist pro Token + IP gedrosselt', async () => {
  const link = editorLink();
  let last;
  for (let i = 0; i < 40; i++) {
    last = await api('POST', `/share/${link.token}/feedback`,
      { reader_token: `reader${String(i).padStart(4, '0')}`, rating: 5 }, null);
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
  assert.ok(last.json.retry_after > 0);
  const n = db.prepare('SELECT COUNT(*) n FROM share_feedback WHERE share_token = ?').get(link.token).n;
  assert.ok(n <= 30, `höchstens das Limit an Zeilen (${n})`);
});

test('GET /share/:token: Reloads desselben Besuchers legen keine neuen share_views an', async () => {
  const link = editorLink();
  for (let i = 0; i < 5; i++) assert.equal((await api('GET', `/share/${link.token}`, null, null)).status, 200);
  const n = db.prepare('SELECT COUNT(*) n FROM share_views WHERE share_token = ?').get(link.token).n;
  assert.equal(n, 1);
  assert.equal(sl.getShareLinkByToken(link.token).view_count, 5, 'Gesamtzähler zählt weiter jeden Aufruf');
});

// ── 2: Downloads + buchgebundene persönliche Zeilen ────────────────────────

test('Export-Downloads prüfen den Buchzugriff erneut (docx/epub/finetune)', async () => {
  const { createJob } = require('../../routes/jobs/shared');
  const cases = [
    ['docx-export', (id) => `/jobs/docx-export/${id}/file`],
    ['epub-export', (id) => `/jobs/epub-export/${id}/file`],
    ['finetune-export', (id) => `/jobs/finetune-export/${id}/train.jsonl`],
  ];
  for (const [type, url] of cases) {
    bookAccess.grantAccess(BOOK, EDITOR, 'editor', OWNER);
    const id = createJob(type, BOOK, EDITOR, 'job.label.docxExport', null, `t-${type}-${Date.now()}`);
    let r = await api('GET', url(id), null, EDITOR);
    assert.equal(r.status, 409, `${type}: mit Zugriff → noch nicht fertig`);
    bookAccess.revokeAccess(BOOK, EDITOR);
    r = await api('GET', url(id), null, EDITOR);
    assert.equal(r.status, 403, `${type}: ohne Zugriff → 403`);
  }
});

test('GET /history/rueckblick-entry/:id und /chat/session/:id: nach Entzug 403', async () => {
  const rid = db.prepare(`INSERT INTO tagebuch_rueckblicke (book_id, user_email, zeitraum, result_json)
                          VALUES (?, ?, '2026-01', '{}')`).run(BOOK, EDITOR).lastInsertRowid;
  const sid = db.prepare(`INSERT INTO chat_sessions (book_id, kind, user_email, created_at, last_message_at)
                          VALUES (?, 'book', ?, ?, ?)`).run(BOOK, EDITOR, NOW, NOW).lastInsertRowid;
  assert.equal((await api('GET', `/history/rueckblick-entry/${rid}`, null, EDITOR)).status, 200);
  assert.equal((await api('GET', `/chat/session/${sid}`, null, EDITOR)).status, 200);
  bookAccess.revokeAccess(BOOK, EDITOR);
  assert.equal((await api('GET', `/history/rueckblick-entry/${rid}`, null, EDITOR)).status, 403);
  assert.equal((await api('GET', `/chat/session/${sid}`, null, EDITOR)).status, 403);
});

// ── 3: Quelle mit fremdem book_id ──────────────────────────────────────────

test('GET /sources/:id?book_id=X verlangt Leserecht auf X', async () => {
  const { createSource } = require('../../db/sources/pool');
  const { linkSource } = require('../../db/sources/links');
  const src = createSource(OWNER, { title: 'Meine Quelle' });
  linkSource(BOOK, src.id);
  let r = await api('GET', `/sources/${src.id}?book_id=${BOOK}`, null, OWNER);
  assert.equal(r.status, 200);
  r = await api('GET', `/sources/${src.id}?book_id=${OTHER_BOOK}`, null, OWNER);
  assert.equal(r.status, 403, 'Kennzahlen eines fremden Buchs nicht abfragbar');
  r = await api('GET', `/sources/${src.id}`, null, OWNER);
  assert.equal(r.status, 200, 'Pool-Sicht ohne book_id bleibt');
});
