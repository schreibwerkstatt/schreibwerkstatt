'use strict';
// Blog-Sync unter Nebenläufigkeit (routes/jobs/blog-sync.js, lib/blog-pull.js):
//   • Delta-Pull überschreibt keine Seite, die zwischen Klassifizierung und
//     Schreiben gespeichert wurde — savePage bekommt den klassifizierten Stempel
//     (expected_updated_at), der 409 wird zum Konflikt.
//   • Link-Anlage ist idempotent: verliert der Lauf das Rennen um
//     UNIQUE(blog_id, wp_post_id), wird die eben angelegte Seite wieder entfernt
//     (keine verwaiste Seite, kein Job-Fehler).
//   • Import/Pull laufen pro BUCH exklusiv, nicht pro User (_activeBookSyncJob).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.SSRF_SKIP_DNS_CHECK = '1';

const { bootstrap } = require('./_helpers/setup');
const { makeWpStub, installFetch } = require('./_helpers/mock-wp');

let ctx;
let blogSync;
let blogs;
let contentStore;
let blogPull;

test.before(() => {
  ctx = bootstrap();
  blogSync = require('../../routes/jobs/blog-sync');
  blogs = require('../../db/blogs');
  contentStore = require('../../lib/content-store');
  blogPull = require('../../lib/blog-pull');
});
test.after(() => { ctx.cleanup(); });

function seedBlogBook(bookId) {
  const { db } = require('../../db/connection');
  db.prepare(`
    INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(book_id) DO UPDATE SET name=excluded.name
  `).run(bookId, `Blog-Concurrency-${bookId}`);
  ctx.dbSchema.saveBookSettings(bookId, 'de', 'CH', 'blog', null, null, null, 0, 0);
  blogs.upsertConnection({ bookId, baseUrl: 'https://wp.test', username: 'editor', password: 'pw', defaultStatus: 'draft' });
  return blogs.getConnection(bookId);
}

function runningJob(type, bookId, userEmail) {
  const jobId = `test-${type}-${Date.now()}-${Math.random()}`;
  ctx.shared.jobs.set(jobId, { id: jobId, type, bookId: String(bookId), userEmail, status: 'running', progress: 0 });
  return jobId;
}

test.beforeEach(() => {
  ctx.dbSeed.reset();
  const { db } = require('../../db/connection');
  db.prepare('DELETE FROM blog_page_links').run();
  db.prepare('DELETE FROM blog_connections').run();
  ctx.shared.jobs.clear();
});

test('Pull: lokaler Save zwischen Klassifizierung und Schreiben → Konflikt statt Überschreiben', async () => {
  const bookId = 9101;
  const conn = seedBlogBook(bookId);
  blogs.markInitialImportDone(conn.id);
  const page = await contentStore.createPage({ book_id: bookId, chapter_id: null, name: 'Post', html: '<p>Alt.</p>' }, null);
  // Zuletzt gepullt „in der Zukunft" → keine lokale Änderung seither; WP ist neuer → 'update'.
  blogs.upsertLink({
    pageId: page.id, blogId: conn.id, wpPostId: 31, wpModifiedAt: '2026-04-01T00:00:00',
    wpStatus: 'publish', wpSlug: 'post', lastPulledAt: '2099-01-01T00:00:00',
  });
  const wp = makeWpStub({
    posts: [{
      id: 31, title: { rendered: 'Post', raw: 'Post' },
      content: { rendered: '<p>WP-Stand.</p>', raw: '<p>WP-Stand.</p>' },
      status: 'publish', slug: 'post', modified_gmt: '2026-05-01T00:00:00', date_gmt: '2026-04-01T00:00:00',
    }],
  });
  const restore = installFetch(wp);
  // Mitautor speichert genau zwischen loadPage/classifyPull und dem Pull-Write.
  const origSave = contentStore.savePage;
  let guarded = null;
  contentStore.savePage = async (id, body, c) => {
    if (id === page.id && body?.expected_updated_at && guarded === null) {
      guarded = body.expected_updated_at;
      await new Promise((r) => setTimeout(r, 5));
      await origSave(id, { html: '<p>Mitautor-Edit.</p>' }, null);
    }
    return origSave(id, body, c);
  };
  try {
    const jobId = runningJob('blog-pull', bookId, null);
    await blogSync.runBlogPullJob(jobId, bookId, null);
    const job = ctx.shared.jobs.get(jobId);
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.ok(guarded, 'Pull muss expected_updated_at mitschicken');
    assert.equal(job.result.conflicts, 1);
    assert.equal(job.result.updated, 0);
    const reloaded = await contentStore.loadPage(page.id);
    assert.match(reloaded.html, /Mitautor-Edit/);
    assert.equal(blogs.getLinkByPage(page.id).conflict_state, 'detected');
  } finally {
    contentStore.savePage = origSave;
    restore();
  }
});

test('Pull: ohne Zwischen-Save wird aktualisiert (Guard blockiert den Normalfall nicht)', async () => {
  const bookId = 9102;
  const conn = seedBlogBook(bookId);
  blogs.markInitialImportDone(conn.id);
  const page = await contentStore.createPage({ book_id: bookId, chapter_id: null, name: 'Post', html: '<p>Alt.</p>' }, null);
  blogs.upsertLink({
    pageId: page.id, blogId: conn.id, wpPostId: 32, wpModifiedAt: '2026-04-01T00:00:00',
    wpStatus: 'publish', wpSlug: 'post', lastPulledAt: '2099-01-01T00:00:00',
  });
  const restore = installFetch(makeWpStub({
    posts: [{
      id: 32, title: { rendered: 'Post', raw: 'Post' },
      content: { rendered: '<p>WP-Stand.</p>', raw: '<p>WP-Stand.</p>' },
      status: 'publish', slug: 'post', modified_gmt: '2026-05-01T00:00:00', date_gmt: '2026-04-01T00:00:00',
    }],
  }));
  try {
    const jobId = runningJob('blog-pull', bookId, null);
    await blogSync.runBlogPullJob(jobId, bookId, null);
    const job = ctx.shared.jobs.get(jobId);
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.updated, 1);
    assert.match((await contentStore.loadPage(page.id)).html, /WP-Stand/);
  } finally { restore(); }
});

test('createLinkedPageFromPost: verlorenes UNIQUE-Rennen → Seite wieder entfernt, null', async () => {
  const bookId = 9103;
  const conn = seedBlogBook(bookId);
  // Ein anderer Lauf hat den Post schon verlinkt …
  const other = await contentStore.createPage({ book_id: bookId, chapter_id: null, name: 'Erster', html: '<p>x</p>' }, null);
  blogs.upsertLink({ pageId: other.id, blogId: conn.id, wpPostId: 41, wpModifiedAt: '2026-04-01T00:00:00' });
  // … aber dieser Lauf hat noch den Stand VOR dessen Link gesehen.
  const origGet = blogs.getLinkByPost;
  blogs.getLinkByPost = () => null;
  try {
    const before = (await contentStore.listPages(bookId, null)).length;
    const post = {
      id: 41, title: { rendered: 'Zweiter', raw: 'Zweiter' }, content: { raw: '<p>y</p>' },
      status: 'publish', slug: 'zweiter', date_gmt: '2026-04-01T00:00:00',
    };
    const res = await blogPull.createLinkedPageFromPost({
      conn, bookId, post, chapterCache: new Map(), userEmail: null, citeStats: {}, wpModifiedAt: '2026-04-01T00:00:00',
    });
    assert.equal(res, null);
    const pages = await contentStore.listPages(bookId, null);
    assert.equal(pages.length, before, 'keine verwaiste Seite');
  } finally {
    blogs.getLinkByPost = origGet;
  }
  assert.equal(blogs.getLinkByPost(conn.id, 41).page_id, other.id);
});

test('_activeBookSyncJob: Import/Pull pro Buch exklusiv, unabhängig vom User', () => {
  runningJob('blog-pull', 9104, 'alice@x');
  assert.equal(blogSync._activeBookSyncJob(9104)?.userEmail, 'alice@x');
  assert.equal(blogSync._activeBookSyncJob(9105), null);
  // Push zählt nicht (eigene Dedup pro User).
  runningJob('blog-push', 9105, 'bob@x');
  assert.equal(blogSync._activeBookSyncJob(9105), null);
  const done = runningJob('blog-import', 9106, 'bob@x');
  ctx.shared.jobs.get(done).status = 'done';
  assert.equal(blogSync._activeBookSyncJob(9106), null);
});
