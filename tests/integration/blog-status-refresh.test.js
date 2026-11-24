'use strict';
// Remote-Status ohne manuellen Pull nachziehen (docs/blog-sync.md#abgleich):
//   - POST /blog/:book_id/pages/:page_id/refresh-status — beim Oeffnen eines
//     Abschnitts, ein GET auf den Beitrag; ein geloeschter Beitrag wird nur
//     gemeldet, der Link bleibt.
//   - routes/jobs/sync/nightly.js#reconcileAllConnections — naechtlicher
//     Abgleich-Job je verbundenem Blog-Buch, unter dem Buch-Owner.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.SSRF_SKIP_DNS_CHECK = '1';

const { bootstrap, waitForJob } = require('./_helpers/setup');
const { makeWpStub } = require('./_helpers/mock-wp');

const OWNER = 'owner@test.dev';
const BOOK = 9421;
const OTHER_BOOK = 9422; // verbunden, aber kein Blog-Buch mehr
const NOW = '2026-01-01T00:00:00.000Z';

let ctx;
let db;
let blogs;
let contentStore;
let server;
let baseUrl;
let realFetch;
let wp;

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  blogs = require('../../db/blogs');
  contentStore = require('../../lib/content-store');
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (baseUrl && String(url).startsWith(baseUrl)) return realFetch(url, opts);
    return wp.fetch(url, opts);
  };
  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: OWNER } }; next(); });
  app.use('/blog', require('../../routes/blog'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => {
  globalThis.fetch = realFetch;
  if (server) server.close();
  ctx.cleanup();
});

function seedBook(bookId, buchtyp) {
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(bookId, `B${bookId}`, NOW, NOW);
  require('../../db/book-access').grantAccess(bookId, OWNER, 'owner', OWNER);
  ctx.dbSchema.saveBookSettings(bookId, { language: 'de', region: 'CH', buchtyp, buch_kontext: null, erzaehlperspektive: null, erzaehlzeit: null, is_finished: 0, allow_lektor_book_chat: 0 });
  blogs.upsertConnection({ bookId, baseUrl: 'https://wp.test', username: 'owner', password: 'pw', defaultStatus: 'draft' });
}

async function seedLinkedPage(bookId, postId, wpStatus) {
  const connId = blogs.getConnection(bookId).id;
  const page = await contentStore.createPage({ book_id: bookId, chapter_id: null, name: `P${postId}`, html: '<p>Text.</p>' }, null);
  blogs.upsertLink({
    pageId: page.id, blogId: connId, wpPostId: postId,
    wpModifiedAt: '2026-06-18T17:48:54', wpStatus, lastPushedAt: '2026-06-18T17:48:54.669Z',
  });
  return page;
}

function post(id, status) {
  return {
    id, title: { rendered: `P${id}`, raw: `P${id}` },
    content: { rendered: '<p>Text.</p>', raw: '<p>Text.</p>' },
    status, slug: `p${id}`, modified_gmt: '2026-06-18T17:49:42', date_gmt: '2026-06-18T17:49:42',
  };
}

test.beforeEach(() => {
  ctx.dbSeed.reset();
  db.prepare('DELETE FROM blog_page_links').run();
  db.prepare('DELETE FROM blog_connections').run();
  db.prepare('DELETE FROM books').run();
  db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(OWNER);
});

async function refresh(bookId, pageId) {
  const res = await realFetch(`${baseUrl}/blog/${bookId}/pages/${pageId}/refresh-status`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('refresh-status: in WordPress veröffentlichter Entwurf → wp_status publish, changed', async () => {
  seedBook(BOOK, 'blog');
  const page = await seedLinkedPage(BOOK, 2202, 'draft');
  wp = makeWpStub({ posts: [post(2202, 'publish')] });

  const r = await refresh(BOOK, page.id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.changed, true);
  assert.equal(blogs.getLinkByPage(page.id).wp_status, 'publish');

  // Zweiter Aufruf im Drossel-Fenster: kein Request an WordPress.
  const callsBefore = wp.calls.length;
  const r2 = await refresh(BOOK, page.id);
  assert.equal(r2.json.throttled, true);
  assert.equal(wp.calls.length, callsBefore);
});

test('refresh-status: Beitrag im Papierkorb → gone gemeldet, Link bleibt', async () => {
  seedBook(BOOK, 'blog');
  const page = await seedLinkedPage(BOOK, 2203, 'publish');
  wp = makeWpStub({ posts: [post(2203, 'trash')] });

  const r = await refresh(BOOK, page.id);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.gone, true);
  assert.ok(blogs.getLinkByPage(page.id), 'Link darf beim Öffnen nicht verschwinden');
});

test('refresh-status: Abschnitt ohne Link → 404 BLOG_LINK_MISSING, kein Request', async () => {
  seedBook(BOOK, 'blog');
  const page = await contentStore.createPage({ book_id: BOOK, chapter_id: null, name: 'lose', html: '<p>x</p>' }, null);
  wp = makeWpStub({ posts: [] });
  const r = await refresh(BOOK, page.id);
  assert.equal(r.status, 404);
  assert.equal(r.json.error_code, 'BLOG_LINK_MISSING');
  assert.equal(wp.calls.length, 0);
});

test('Nachtlauf: Abgleich je verbundenem Blog-Buch, Status nachgezogen; Nicht-Blog-Buch übersprungen', async () => {
  seedBook(BOOK, 'blog');
  seedBook(OTHER_BOOK, 'roman');
  const page = await seedLinkedPage(BOOK, 2204, 'draft');
  wp = makeWpStub({ posts: [post(2204, 'publish')] });

  const { reconcileAllConnections } = require('../../routes/jobs/sync/nightly');
  const out = reconcileAllConnections();
  assert.equal(out.enqueued, 1);
  assert.equal(out.skipped, 1);

  const job = [...ctx.shared.jobs.values()].find(j => j.type === 'blog-reconcile' && String(j.bookId) === String(BOOK));
  assert.ok(job, 'Abgleich-Job eingereiht');
  assert.equal(job.userEmail, OWNER);
  const done = await waitForJob(ctx.shared, job.id);
  assert.equal(done.status, 'done', JSON.stringify(done.error));
  assert.equal(blogs.getLinkByPage(page.id).wp_status, 'publish');
});
