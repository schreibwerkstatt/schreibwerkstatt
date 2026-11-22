'use strict';
// Öffentliche Share-Leseansicht: Zählung, Drossel, Lebensdauer der Neben-
// Endpunkte, atomares Löschen, Bild-Cache.
//
//   - Link-Vorschau-Bots und der angemeldete Ersteller zählen nicht als Aufruf
//   - GET /share/:token ist pro Link + IP gedrosselt (429 + Retry-After)
//   - der data-bid-Nachzug liest den Bestand nur bei geänderter Signatur
//   - Beacons und feedback/mine respektieren isExpired
//   - Leser-Löschen eines Roots mit Antwort: 409, Antwort bleibt (atomar)
//   - Abschnitts-Bilder gehen mit Cache-Control: private raus
//
// Fährt den echten Share-Router unter Express hoch; die Fake-Session liefert den User.

const test = require('node:test');
const assert = require('node:assert/strict');
const { useTmpDb } = require('../unit/_helpers/tmp-db');

useTmpDb('share-reader-hardening');
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const express = require('express');
const { db } = require('../../db/connection');
require('../../db/migrations').runMigrations();
const appUsers = require('../../db/app-users');
const bookAccess = require('../../db/book-access');
const sl = require('../../db/share-links');
const rateLimit = require('../../lib/share-ratelimit');
const contentStore = require('../../lib/content-store');

const OWNER = 'owner@hardening.test';
const BOOK = 9901;
const PAGE = 99011;
const NOW = '2026-01-01T00:00:00.000Z';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

let sessionUser = null;
let server;
let baseUrl;

function startServer() {
  const app = express();
  app.use((req, _res, next) => {
    req.session = sessionUser ? { user: { email: sessionUser } } : {};
    next();
  });
  app.use('/share', require('../../routes/share'));
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

async function call(method, p, { body, ua = BROWSER_UA, as = null } = {}) {
  sessionUser = as;
  const headers = {};
  if (ua != null) headers['User-Agent'] = ua;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${p}`, {
    method, redirect: 'manual', headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, headers: res.headers, json, text };
}

const viewCount = (token) => sl.getShareLinkByToken(token).view_count;
const viewRows = (token) => db.prepare('SELECT COUNT(*) n FROM share_views WHERE share_token = ?').get(token).n;

test.before(async () => {
  if (!appUsers.getUser(OWNER)) appUsers.createUser({ email: OWNER, displayName: 'Olga Owner' });
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(BOOK, 'Buch', NOW, NOW);
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, position, updated_at, body_html)
              VALUES (?, ?, ?, 0, ?, ?)`).run(PAGE, BOOK, 'Abschnitt', NOW, '<p>Lesetext ohne Block-IDs.</p>');
  await startServer();
});
test.after(() => { server?.close(); });

test.beforeEach(() => {
  rateLimit._resetAll();
  for (const t of ['share_feedback', 'share_comments', 'share_views', 'share_links', 'book_access']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  bookAccess.grantAccess(BOOK, OWNER, 'owner', OWNER);
});

function pageLink() {
  return sl.createShareLink({ kind: 'page', pageId: PAGE, bookId: BOOK, ownerEmail: OWNER });
}

test('Link-Vorschau-Bot bekommt die Seite, zählt aber nicht', async () => {
  const link = pageLink();
  for (const ua of ['WhatsApp/2.23.20.0 A', 'facebookexternalhit/1.1', 'Slackbot-LinkExpanding 1.0', 'TelegramBot (like TwitterBot)', '']) {
    const r = await call('GET', `/share/${link.token}`, { ua });
    assert.equal(r.status, 200, `UA «${ua}» bekommt die Seite`);
    assert.match(r.text, /"viewId":null/, `UA «${ua}» bekommt keinen viewId`);
  }
  assert.equal(viewCount(link.token), 0);
  assert.equal(viewRows(link.token), 0);

  const r = await call('GET', `/share/${link.token}`);
  assert.equal(r.status, 200);
  assert.equal(viewCount(link.token), 1, 'ein echter Browser zählt');
  assert.equal(viewRows(link.token), 1);
});

test('Der angemeldete Ersteller zählt nicht, ein anderer Angemeldeter schon', async () => {
  const link = pageLink();
  assert.equal((await call('GET', `/share/${link.token}`, { as: OWNER })).status, 200);
  assert.equal(viewCount(link.token), 0, 'Ersteller prüft seinen Link');
  assert.equal(viewRows(link.token), 0);
  assert.equal((await call('GET', `/share/${link.token}`, { as: 'jemand@anders.test' })).status, 200);
  assert.equal(viewCount(link.token), 1);
});

test('GET /share/:token ist pro Link + IP gedrosselt', async () => {
  const link = pageLink();
  let last;
  for (let i = 0; i <= rateLimit.VIEW_MAX_PER_WINDOW; i++) {
    last = await call('GET', `/share/${link.token}`, { ua: 'WhatsApp/2' }); // Bot: kein Schreiben in share_views
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
});

test('data-bid-Nachzug liest den Bestand nur bei geänderter Signatur', async () => {
  const link = pageLink();
  const orig = contentStore.backfillBlockIds;
  let calls = 0;
  contentStore.backfillBlockIds = async (...a) => { calls++; return orig(...a); };
  try {
    await call('GET', `/share/${link.token}`);
    await call('GET', `/share/${link.token}`);
    await call('GET', `/share/${link.token}`);
    assert.equal(calls, 1, 'zweiter und dritter Aufruf überspringen den Scan');
    db.prepare('UPDATE pages SET updated_at = ? WHERE page_id = ?').run('2026-02-02T00:00:00.000Z', PAGE);
    await call('GET', `/share/${link.token}`);
    assert.equal(calls, 2, 'geänderter Abschnitt → neuer Scan');
  } finally {
    contentStore.backfillBlockIds = orig;
  }
  assert.match(db.prepare('SELECT body_html FROM pages WHERE page_id = ?').get(PAGE).body_html, /data-bid=/);
});

test('Beacons und feedback/mine eines widerrufenen Links schreiben/liefern nichts', async () => {
  const link = pageLink();
  const viewId = sl.recordShareView(link.token, 'ipX');
  sl.upsertFeedback(link.token, { readerToken: 'reader0001', rating: 4 });
  db.prepare('UPDATE share_links SET revoked_at = ? WHERE token = ?').run(NOW, link.token);

  assert.equal((await call('POST', `/share/${link.token}/view-duration`, { body: { viewId, durationMs: 5000 } })).status, 204);
  assert.equal((await call('POST', `/share/${link.token}/read-depth`, { body: { viewId, maxScrollPct: 80 } })).status, 204);
  const row = db.prepare('SELECT duration_ms, max_scroll_pct FROM share_views WHERE id = ?').get(viewId);
  assert.equal(row.duration_ms, null);
  assert.equal(row.max_scroll_pct, null);

  const mine = await call('GET', `/share/${link.token}/feedback/mine?rt=reader0001`);
  assert.equal(mine.status, 404);
  assert.equal(mine.json?.feedback, undefined);
});

test('Beacons eines lebenden Links schreiben weiter', async () => {
  const link = pageLink();
  const viewId = sl.recordShareView(link.token, 'ipY');
  assert.equal((await call('POST', `/share/${link.token}/view-duration`, { body: { viewId, durationMs: 5000 } })).status, 204);
  assert.equal(db.prepare('SELECT duration_ms FROM share_views WHERE id = ?').get(viewId).duration_ms, 5000);
});

test('Leser löscht eigenen Root mit Antwort → 409, Antwort bleibt; ohne Antwort → weg', async () => {
  const link = pageLink();
  const root = sl.insertComment({ token: link.token, readerToken: 'reader0002', body: 'Frage' });
  sl.insertOwnerReply({ token: link.token, parentId: root.id, authorEmail: OWNER, body: 'Antwort' });

  // DB-Ebene: das DELETE selbst verweigert (atomar, kein Prüf-dann-Lösch-Fenster).
  assert.equal(sl.deleteReaderComment(root.id, link.token, 'reader0002'), false);

  const r = await call('DELETE', `/share/${link.token}/comment/${root.id}`, { body: { reader_token: 'reader0002' } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error_code, 'HAS_REPLIES');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM share_comments WHERE share_token = ?').get(link.token).n, 2);

  const lone = sl.insertComment({ token: link.token, readerToken: 'reader0002', body: 'Allein' });
  const ok = await call('DELETE', `/share/${link.token}/comment/${lone.id}`, { body: { reader_token: 'reader0002' } });
  assert.equal(ok.status, 200);
  const notMine = await call('DELETE', `/share/${link.token}/comment/${root.id}`, { body: { reader_token: 'fremd00001' } });
  assert.equal(notMine.status, 404);
});

test('Abschnitts-Bild: Cache-Control private', async () => {
  const link = pageLink();
  const { insertPageImage } = require('../../db/page-images');
  // 1×1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const id = insertPageImage({ pageId: PAGE, mime: 'image/png', image: png });
  const r = await call('GET', `/share/${link.token}/page-image/${id}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /^private\b/);
});
