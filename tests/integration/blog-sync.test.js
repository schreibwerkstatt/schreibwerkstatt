'use strict';
// Integration test for routes/jobs/blog-sync.js — exercises the three jobs
// (import, pull, push) against an in-process Mock-WP. Mock is wired by
// monkey-patching globalThis.fetch with a tiny route table that mimics the
// WP REST API surface lib/wp-client.js touches. Verifies the LWW merge,
// initial-import gating, and conflict-state detection at the Job-Queue level.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
// Mock-WP laeuft ueber gestubbtes globalThis.fetch mit Reserved-TLD-Host
// (wp.test) — DNS-Aufloesung im SSRF-Guard ueberspringen (Literal-Block bleibt).
process.env.SSRF_SKIP_DNS_CHECK = '1';

const { bootstrap, waitForJob } = require('./_helpers/setup');

let ctx;
let blogSync;
let blogs;
let contentStore;

test.before(() => {
  ctx = bootstrap();
  blogSync = require('../../routes/jobs/blog-sync');
  blogs = require('../../db/blogs');
  contentStore = require('../../lib/content-store');
});
test.after(() => { ctx.cleanup(); });

const { makeWpStub, installFetch } = require('./_helpers/mock-wp');

// ── Test-Buch + Blog-Settings ─────────────────────────────────────────────

function seedBlogBook(bookId) {
  const { db } = require('../../db/connection');
  db.prepare(`
    INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(book_id) DO UPDATE SET name=excluded.name
  `).run(bookId, `Blog-Test-${bookId}`);
  ctx.dbSchema.saveBookSettings(bookId, { language: 'de', region: 'CH', buchtyp: 'blog', buch_kontext: null, erzaehlperspektive: null, erzaehlzeit: null, is_finished: 0, allow_lektor_book_chat: 0 });
}

function seedConnection(bookId) {
  blogs.upsertConnection({
    bookId,
    baseUrl: 'https://wp.test',
    username: 'editor',
    password: 'pw',
    defaultStatus: 'draft',
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

test.beforeEach(() => {
  ctx.dbSeed.reset();
  const { db } = require('../../db/connection');
  db.prepare('DELETE FROM blog_page_links').run();
  db.prepare('DELETE FROM blog_connections').run();
});

test('Initial-Import: holt alle Posts und legt Pages an', async () => {
  const bookId = 9001;
  seedBlogBook(bookId);
  seedConnection(bookId);

  const wp = makeWpStub({
    posts: [
      {
        id: 11, title: { rendered: 'Post Eins', raw: 'Post Eins' },
        content: {
          rendered: '<!-- wp:paragraph --><p>Hallo Welt.</p><!-- /wp:paragraph -->',
          raw: '<!-- wp:paragraph --><p>Hallo Welt.</p><!-- /wp:paragraph -->',
        },
        status: 'publish', slug: 'post-eins',
        modified_gmt: '2026-04-01T10:00:00', date_gmt: '2026-04-01T10:00:00',
      },
      {
        id: 12, title: { rendered: 'Post Zwei', raw: 'Post Zwei' },
        content: { rendered: '<p>Zweiter Eintrag.</p>', raw: '<p>Zweiter Eintrag.</p>' },
        status: 'draft', slug: 'post-zwei',
        modified_gmt: '2026-04-02T10:00:00', date_gmt: '2026-04-02T10:00:00',
      },
    ],
  });
  const restore = installFetch(wp);
  try {
    const jobId = `test-import-${Date.now()}`;
    const { jobs, runningJobs } = ctx.shared;
    jobs.set(jobId, {
      id: jobId, type: 'blog-import', bookId, userEmail: 'tester@test.dev',
      status: 'running', progress: 0, createdAt: Date.now(), result: null, error: null,
    });
    runningJobs.set(jobId, { type: 'blog-import', bookId, userEmail: 'tester@test.dev' });

    await blogSync.runBlogImportJob(jobId, bookId, 'tester@test.dev');

    const job = jobs.get(jobId);
    assert.equal(job.status, 'done', job.error || '');
    assert.equal(job.result.imported, 2);

    const conn = blogs.getConnectionPublic(bookId);
    assert.ok(conn.initialImportDoneAt, 'initialImportDoneAt set');

    const links = blogs.listLinksForBlog(blogs.getConnection(bookId).id);
    assert.equal(links.length, 2);

    const pages = await contentStore.listPages(bookId, null);
    assert.equal(pages.length, 2);
    const firstLink = links.find(l => l.wp_post_id === 11);
    const firstPage = await contentStore.loadPage(firstLink.page_id);
    const firstHtml = firstPage.html || firstPage.body_html;
    assert.match(firstHtml, /Hallo Welt/);
    assert.doesNotMatch(firstHtml, /wp:paragraph/);
  } finally {
    restore();
  }
});

test('Initial-Import: zweiter Lauf failed mit BLOG_ALREADY_IMPORTED', async () => {
  const bookId = 9002;
  seedBlogBook(bookId);
  seedConnection(bookId);
  blogs.markInitialImportDone(blogs.getConnection(bookId).id);

  const wp = makeWpStub({ posts: [] });
  const restore = installFetch(wp);
  try {
    const jobId = `test-import-2-${Date.now()}`;
    const { jobs, runningJobs } = ctx.shared;
    jobs.set(jobId, { id: jobId, type: 'blog-import', bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
    runningJobs.set(jobId, { type: 'blog-import', bookId });

    await blogSync.runBlogImportJob(jobId, bookId, null);
    const job = jobs.get(jobId);
    assert.equal(job.status, 'error');
    assert.match(JSON.stringify(job.error || ''), /BLOG_ALREADY_IMPORTED/);
  } finally {
    restore();
  }
});

test('Push: lokal editierte Seite wird zu WP gepusht (Update)', async () => {
  const bookId = 9003;
  seedBlogBook(bookId);
  seedConnection(bookId);
  const connId = blogs.getConnection(bookId).id;
  blogs.markInitialImportDone(connId);

  // Seed-Page + Link. Page-Name in App weicht vom WP-Titel ab: eine
  // Umbenennung in der App muss beim Update-Push in WordPress ankommen.
  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null, name: 'App-Name',
    html: '<h2>Update</h2><p>Geänderter Text.</p>',
  }, null);
  blogs.upsertLink({
    pageId: page.id, blogId: connId,
    wpPostId: 11, wpModifiedAt: '2026-04-01T10:00:00',
    wpStatus: 'publish', wpSlug: 'pushable',
    lastPulledAt: '2026-04-01T10:00:00',
    lastPushedAt: '2026-04-01T10:00:00',
  });

  const wp = makeWpStub({
    posts: [{
      id: 11, title: { rendered: 'WP-Original', raw: 'WP-Original' },
      content: { rendered: '<p>alt</p>', raw: '<p>alt</p>' },
      status: 'publish', slug: 'pushable',
      modified_gmt: '2026-04-01T10:00:00', date_gmt: '2026-04-01T10:00:00',
    }],
  });
  const restore = installFetch(wp);
  try {
    const jobId = `test-push-${Date.now()}`;
    const { jobs, runningJobs } = ctx.shared;
    jobs.set(jobId, { id: jobId, type: 'blog-push', bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
    runningJobs.set(jobId, { type: 'blog-push', bookId });

    await blogSync.runBlogPushJob(jobId, bookId, null, [page.id]);
    const job = jobs.get(jobId);
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.pushed, 1);

    const updatedRemote = wp.posts.find(p => p.id === 11);
    assert.match(updatedRemote.content.raw, /wp:heading/);
    assert.match(updatedRemote.content.raw, /Geänderter Text/);
    assert.equal(updatedRemote.title.raw, 'App-Name', 'Update-Push traegt den Seitennamen als Titel');
  } finally {
    restore();
  }
});

test('Push (Create): praegt Page-Name mit YYYY-MM-DD-Prefix von heute', async () => {
  const bookId = 9005;
  seedBlogBook(bookId);
  seedConnection(bookId);
  const connId = blogs.getConnection(bookId).id;
  blogs.markInitialImportDone(connId);

  // Page ohne Link → noch nicht in WP
  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null, name: 'Neuer App-Titel',
    html: '<p>Frischer Eintrag.</p>',
  }, null);

  const { localIsoDate } = require('../../lib/local-date');
  const expected = `${localIsoDate()}: Neuer App-Titel`;

  const wp = makeWpStub({ posts: [] });
  const restore = installFetch(wp);
  try {
    const jobId = `test-push-new-${Date.now()}`;
    const { jobs, runningJobs } = ctx.shared;
    jobs.set(jobId, { id: jobId, type: 'blog-push', bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
    runningJobs.set(jobId, { type: 'blog-push', bookId });

    await blogSync.runBlogPushJob(jobId, bookId, null, [page.id]);
    const job = jobs.get(jobId);
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.createdRemote, 1);

    const created = wp.posts[0];
    assert.ok(created, 'WP-Post wurde nicht angelegt');
    // WP bekommt den Titel OHNE Datum-Prefix (app-intern).
    assert.equal(created.title.raw, 'Neuer App-Titel');
    // Lokaler page_name behält den Datum-Prefix.
    const reloaded = await contentStore.loadPage(page.id);
    assert.equal(reloaded.name, expected);
    // Job-Result liefert die lokale Umbenennung für den Frontend-Refresh.
    assert.deepEqual(job.result.renamed, [{ pageId: page.id, name: expected }]);
  } finally {
    restore();
  }
});

test('Push (Create): leerer Titel wird zu YYYY-MM-DD von heute', async () => {
  const bookId = 9008;
  seedBlogBook(bookId);
  seedConnection(bookId);
  const connId = blogs.getConnection(bookId).id;
  blogs.markInitialImportDone(connId);

  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null, name: '   ',
    html: '<p>Ohne Titel.</p>',
  }, null);

  const { localIsoDate } = require('../../lib/local-date');
  const expected = localIsoDate();

  const wp = makeWpStub({ posts: [] });
  const restore = installFetch(wp);
  try {
    const jobId = `test-push-empty-${Date.now()}`;
    const { jobs, runningJobs } = ctx.shared;
    jobs.set(jobId, { id: jobId, type: 'blog-push', bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
    runningJobs.set(jobId, { type: 'blog-push', bookId });

    await blogSync.runBlogPushJob(jobId, bookId, null, [page.id]);
    const job = jobs.get(jobId);
    assert.equal(job.status, 'done', JSON.stringify(job.error));

    // Leerer Rest → WP bekommt leeren Titel, lokal nur das Datum.
    assert.equal(wp.posts[0].title.raw, '');
    const reloaded = await contentStore.loadPage(page.id);
    assert.equal(reloaded.name, expected);
  } finally {
    restore();
  }
});

test('Push (Create): bumpt YYYY-MM-DD im Titel auf heute, lokal + WP synchron', async () => {
  const bookId = 9006;
  seedBlogBook(bookId);
  seedConnection(bookId);
  const connId = blogs.getConnection(bookId).id;
  blogs.markInitialImportDone(connId);

  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null,
    name: '2020-01-01: Mein Eintrag',
    html: '<p>Inhalt.</p>',
  }, null);

  const { localIsoDate } = require('../../lib/local-date');
  const today = localIsoDate();
  const expected = `${today}: Mein Eintrag`;

  const wp = makeWpStub({ posts: [] });
  const restore = installFetch(wp);
  try {
    const jobId = `test-push-bump-${Date.now()}`;
    const { jobs, runningJobs } = ctx.shared;
    jobs.set(jobId, { id: jobId, type: 'blog-push', bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
    runningJobs.set(jobId, { type: 'blog-push', bookId });

    await blogSync.runBlogPushJob(jobId, bookId, null, [page.id]);
    const job = jobs.get(jobId);
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.createdRemote, 1);

    // WP bekommt nur den Rest ohne Datum, lokal wird der Prefix auf heute gebumpt.
    assert.equal(wp.posts[0].title.raw, 'Mein Eintrag', 'WP-Titel sollte ohne Datum sein');

    const reloaded = await contentStore.loadPage(page.id);
    assert.equal(reloaded.name, expected, 'Lokaler page_name sollte heute-bumpt sein');
  } finally {
    restore();
  }
});

test('Push (Create): Titel ohne YYYY-MM-DD bekommt heute als Prefix', async () => {
  const bookId = 9007;
  seedBlogBook(bookId);
  seedConnection(bookId);
  const connId = blogs.getConnection(bookId).id;
  blogs.markInitialImportDone(connId);

  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null,
    name: 'Kein Datum hier',
    html: '<p>Inhalt.</p>',
  }, null);

  const { localIsoDate } = require('../../lib/local-date');
  const expected = `${localIsoDate()}: Kein Datum hier`;

  const wp = makeWpStub({ posts: [] });
  const restore = installFetch(wp);
  try {
    const jobId = `test-push-nobump-${Date.now()}`;
    const { jobs, runningJobs } = ctx.shared;
    jobs.set(jobId, { id: jobId, type: 'blog-push', bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
    runningJobs.set(jobId, { type: 'blog-push', bookId });

    await blogSync.runBlogPushJob(jobId, bookId, null, [page.id]);
    // WP bekommt den Titel ohne Datum, lokal mit Prefix.
    assert.equal(wp.posts[0].title.raw, 'Kein Datum hier');

    const reloaded = await contentStore.loadPage(page.id);
    assert.equal(reloaded.name, expected);
  } finally {
    restore();
  }
});

test('Pull: erkennt Konflikt wenn beide Seiten nach last_pulled_at neu', async () => {
  const bookId = 9004;
  seedBlogBook(bookId);
  seedConnection(bookId);
  const connId = blogs.getConnection(bookId).id;
  blogs.markInitialImportDone(connId);

  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null, name: 'Konflikt',
    html: '<p>App-Edit nach Pull.</p>',
  }, null);
  // Link sagt: zuletzt gepullt am 2026-04-01; WP-modified war 2026-04-01.
  blogs.upsertLink({
    pageId: page.id, blogId: connId,
    wpPostId: 21, wpModifiedAt: '2026-04-01T00:00:00',
    wpStatus: 'publish', wpSlug: 'konflikt',
    lastPulledAt: '2026-04-01T00:00:00',
  });

  // WP-Stub liefert neueren modified_gmt → konkurrierende Änderung.
  const wp = makeWpStub({
    posts: [{
      id: 21, title: { rendered: 'Konflikt', raw: 'Konflikt' },
      content: { rendered: '<p>WP-Edit nach Pull.</p>', raw: '<p>WP-Edit nach Pull.</p>' },
      status: 'publish', slug: 'konflikt',
      modified_gmt: '2026-05-01T00:00:00', date_gmt: '2026-04-01T00:00:00',
    }],
  });
  const restore = installFetch(wp);
  try {
    const jobId = `test-pull-${Date.now()}`;
    const { jobs, runningJobs } = ctx.shared;
    jobs.set(jobId, { id: jobId, type: 'blog-pull', bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
    runningJobs.set(jobId, { type: 'blog-pull', bookId });

    await blogSync.runBlogPullJob(jobId, bookId, null);
    const job = jobs.get(jobId);
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.conflicts, 1);

    const link = blogs.getLinkByPage(page.id);
    assert.equal(link.conflict_state, 'detected');
  } finally {
    restore();
  }
});

// ── Papierkorb: WordPress liefert den Post mit context=edit weiter aus ───────

async function trashedSetup(bookId) {
  seedBlogBook(bookId);
  seedConnection(bookId);
  const connId = blogs.getConnection(bookId).id;
  blogs.markInitialImportDone(connId);
  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null, name: 'Weg', html: '<p>Text.</p>',
  }, null);
  blogs.upsertLink({
    pageId: page.id, blogId: connId,
    wpPostId: 21, wpModifiedAt: '2026-04-01T10:00:00',
    wpStatus: 'publish', lastPulledAt: '2026-04-01T10:00:00',
  });
  const wp = makeWpStub({
    posts: [{
      id: 21, title: { rendered: 'Weg', raw: 'Weg' },
      content: { rendered: '<p>alt</p>', raw: '<p>alt</p>' },
      status: 'trash', slug: 'weg',
      modified_gmt: '2026-04-01T10:00:00', date_gmt: '2026-04-01T10:00:00',
    }],
  });
  return { page, wp };
}

function runJob(type, bookId, fn) {
  const jobId = `test-${type}-${Date.now()}-${Math.random()}`;
  const { jobs, runningJobs } = ctx.shared;
  jobs.set(jobId, { id: jobId, type, bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
  runningJobs.set(jobId, { type, bookId });
  return fn(jobId).then(() => jobs.get(jobId));
}

test('Push: Post im Papierkorb → Link weg, BLOG_REMOTE_GONE, kein Update auf den Papierkorb-Post', async () => {
  const { page, wp } = await trashedSetup(9010);
  const restore = installFetch(wp);
  try {
    const job = await runJob('blog-push', 9010, (id) => blogSync.runBlogPushJob(id, 9010, null, [page.id]));
    assert.equal(job.status, 'error');
    assert.match(String(job.error || ''), /BLOG_REMOTE_GONE/);
    assert.equal(blogs.getLinkByPage(page.id), null);
    assert.equal(wp.posts.find(p => p.id === 21).content.raw, '<p>alt</p>');
  } finally {
    restore();
  }
});

test('Abgleich: Post im Papierkorb gilt als verwaist', async () => {
  const { page, wp } = await trashedSetup(9011);
  const restore = installFetch(wp);
  try {
    const job = await runJob('blog-reconcile', 9011, (id) => blogSync.runBlogReconcileJob(id, 9011, null));
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.removed, 1);
    assert.equal(blogs.getLinkByPage(page.id), null);
  } finally {
    restore();
  }
});
