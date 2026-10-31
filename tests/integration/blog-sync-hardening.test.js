'use strict';
// Blog-Sync (WordPress): Sync-Punkt, Bild-Cache, Push-Sperre und Block-IDs auf
// Job-Ebene gegen den Mock-WP (tests/integration/_helpers/mock-wp.js).
//   - Ein Save WAEHREND des Pushs bleibt eine offene lokale Aenderung.
//   - Ein Bild wird einmal hochgeladen, nicht bei jedem Push.
//   - Scheitert die Umbenennung nach einem Create, steht der Link trotzdem.
//   - Ein Beitrag mit Galerie ist schon nach dem Import als gesperrt markiert.
//   - Der Pull behaelt die Block-IDs unveraenderter Absaetze.

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

test.before(() => {
  ctx = bootstrap();
  blogSync = require('../../routes/jobs/blog-sync');
  blogs = require('../../db/blogs');
  contentStore = require('../../lib/content-store');
});
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.dbSeed.reset();
  const { db } = require('../../db/connection');
  db.prepare('DELETE FROM sync_media_cache').run();
  db.prepare('DELETE FROM blog_page_links').run();
  db.prepare('DELETE FROM blog_connections').run();
});

function seedBlogBook(bookId) {
  const { db } = require('../../db/connection');
  db.prepare(`
    INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(book_id) DO UPDATE SET name=excluded.name
  `).run(bookId, `Blog-Haerte-${bookId}`);
  ctx.dbSchema.saveBookSettings(bookId, { language: 'de', region: 'CH', buchtyp: 'blog', buch_kontext: null, erzaehlperspektive: null, erzaehlzeit: null, is_finished: 0, allow_lektor_book_chat: 0 });
  blogs.upsertConnection({ bookId, baseUrl: 'https://wp.test', username: 'editor', password: 'pw', defaultStatus: 'draft' });
  const connId = blogs.getConnection(bookId).id;
  return connId;
}

function runJob(type, bookId, fn) {
  const jobId = `test-${type}-${Date.now()}-${Math.random()}`;
  const { jobs, runningJobs } = ctx.shared;
  jobs.set(jobId, { id: jobId, type, bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
  runningJobs.set(jobId, { type, bookId });
  return fn(jobId).then(() => jobs.get(jobId));
}

const STAMP = '2026-04-01T10:00:00';
function post(id, content, extra = {}) {
  return {
    id, title: { rendered: `Post ${id}`, raw: `Post ${id}` },
    content: { rendered: content, raw: content },
    status: 'publish', slug: `post-${id}`, modified_gmt: STAMP, date_gmt: STAMP, ...extra,
  };
}

async function linkedPage(bookId, connId, wpPostId, html) {
  const page = await contentStore.createPage({ book_id: bookId, chapter_id: null, name: 'Seite', html }, null);
  blogs.upsertLink({
    pageId: page.id, blogId: connId, wpPostId, wpModifiedAt: STAMP,
    wpStatus: 'publish', lastPulledAt: STAMP, lastPushedAt: STAMP,
  });
  return page;
}

test('Push: ein Save waehrend des Pushs bleibt eine offene lokale Aenderung', async () => {
  const bookId = 9101;
  const connId = seedBlogBook(bookId);
  blogs.markInitialImportDone(connId);
  const page = await linkedPage(bookId, connId, 31, '<p>Stand A.</p>');
  const wp = makeWpStub({ posts: [post(31, '<p>alt</p>')] });
  // Der User speichert, waehrend WordPress noch an der Antwort arbeitet.
  wp.beforeWrite = async () => {
    wp.beforeWrite = null;
    await new Promise(r => setTimeout(r, 5));
    await contentStore.savePage(page.id, { html: '<p>Stand B, nach dem Lesen.</p>' }, null);
  };
  const restore = installFetch(wp);
  try {
    const job = await runJob('blog-push', bookId, (id) => blogSync.runBlogPushJob(id, bookId, null, [page.id]));
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    const link = blogs.getLinkByPage(page.id);
    const fresh = await contentStore.loadPage(page.id);
    assert.ok(fresh.updated_at > link.last_pushed_at,
      `Sync-Punkt ${link.last_pushed_at} darf den Save ${fresh.updated_at} nicht einschliessen`);
    assert.doesNotMatch(wp.posts.find(p => p.id === 31).content.raw, /Stand B/);
  } finally {
    restore();
  }
});

const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('Push: ein Bild wird einmal hochgeladen, nicht bei jedem Push', async () => {
  const bookId = 9102;
  const connId = seedBlogBook(bookId);
  blogs.markInitialImportDone(connId);
  const page = await linkedPage(bookId, connId, 32, `<p>Text.</p><figure><img src="${PNG_DATA_URI}" alt="Punkt"></figure>`);
  const wp = makeWpStub({ posts: [post(32, '<p>alt</p>')] });
  const restore = installFetch(wp);
  try {
    const first = await runJob('blog-push', bookId, (id) => blogSync.runBlogPushJob(id, bookId, null, [page.id]));
    assert.equal(first.status, 'done', JSON.stringify(first.error));
    assert.equal(first.result.imagesUploaded, 1);
    await contentStore.savePage(page.id, { html: `<p>Text, geaendert.</p><figure><img src="${PNG_DATA_URI}" alt="Punkt"></figure>` }, null);
    const second = await runJob('blog-push', bookId, (id) => blogSync.runBlogPushJob(id, bookId, null, [page.id]));
    assert.equal(second.status, 'done', JSON.stringify(second.error));
    assert.equal(second.result.imagesUploaded, 0, 'zweiter Push: Treffer im Cache, kein Upload');
    assert.equal(wp.media.length, 1);
    assert.match(wp.posts.find(p => p.id === 32).content.raw, /img-5000\.png/);

    // „Verbindung prüfen" leert den Cache: ein drueben geloeschtes Bild kaeme sonst nie wieder.
    await runJob('blog-reconcile', bookId, (id) => blogSync.runBlogReconcileJob(id, bookId, null));
    await contentStore.savePage(page.id, { html: `<p>Dritter Stand.</p><figure><img src="${PNG_DATA_URI}" alt="Punkt"></figure>` }, null);
    const third = await runJob('blog-push', bookId, (id) => blogSync.runBlogPushJob(id, bookId, null, [page.id]));
    assert.equal(third.status, 'done', JSON.stringify(third.error));
    assert.equal(wp.media.length, 2);
  } finally {
    restore();
  }
});

test('Push (Create): scheitert die Umbenennung, steht der Link trotzdem', async () => {
  const bookId = 9103;
  const connId = seedBlogBook(bookId);
  blogs.markInitialImportDone(connId);
  const page = await contentStore.createPage({ book_id: bookId, chapter_id: null, name: 'Ohne Datum', html: '<p>Neu.</p>' }, null);
  const wp = makeWpStub({ posts: [] });
  const restore = installFetch(wp);
  const orig = contentStore.savePage;
  contentStore.savePage = async (id, body, c) => {
    if (body && body.name && body.html === undefined) throw Object.assign(new Error('boom'), { code: 'DISK_FULL' });
    return orig(id, body, c);
  };
  try {
    const job = await runJob('blog-push', bookId, (id) => blogSync.runBlogPushJob(id, bookId, null, [page.id]));
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.createdRemote, 1);
    assert.ok(blogs.getLinkByPage(page.id), 'ohne Link legte der naechste Push ein Duplikat an');
    assert.equal(wp.posts.length, 1);
  } finally {
    contentStore.savePage = orig;
    restore();
  }
});

test('Import: Beitrag mit Galerie ist gesperrt — Badge-Feld gesetzt, Push abgewiesen', async () => {
  const bookId = 9104;
  seedBlogBook(bookId);
  const gallery = '<!-- wp:gallery --><figure class="wp-block-gallery"><!-- wp:image {"id":1} --><figure class="wp-block-image"><img src="https://wp.test/a.jpg" class="wp-image-1"/></figure><!-- /wp:image --><!-- wp:image {"id":2} --><figure class="wp-block-image"><img src="https://wp.test/b.jpg" class="wp-image-2"/></figure><!-- /wp:image --></figure><!-- /wp:gallery -->';
  const wp = makeWpStub({ posts: [post(41, gallery), post(42, '<!-- wp:paragraph --><p>Schlicht.</p><!-- /wp:paragraph -->')] });
  const restore = installFetch(wp);
  try {
    const imp = await runJob('blog-import', bookId, (id) => blogSync.runBlogImportJob(id, bookId, null));
    assert.equal(imp.status, 'done', JSON.stringify(imp.error));
    const connId = blogs.getConnection(bookId).id;
    const links = blogs.listLinksForBlog(connId);
    const locked = links.find(l => l.wp_post_id === 41);
    const free = links.find(l => l.wp_post_id === 42);
    assert.match(String(locked.locked_blocks), /wp:gallery/);
    assert.equal(free.locked_blocks, null);

    await contentStore.savePage(locked.page_id, { html: '<p>In der App geaendert.</p>' }, null);
    const push = await runJob('blog-push', bookId, (id) => blogSync.runBlogPushJob(id, bookId, null, [locked.page_id]));
    assert.equal(push.status, 'error');
    assert.match(String(push.error || ''), /BLOG_UNSUPPORTED_BLOCKS/);
    assert.equal(wp.posts.find(p => p.id === 41).content.raw, gallery, 'die Galerie bleibt im Blog');
  } finally {
    restore();
  }
});

test('Pull: unveraenderte Absaetze behalten ihre Block-ID', async () => {
  const bookId = 9105;
  const connId = seedBlogBook(bookId);
  blogs.markInitialImportDone(connId);
  blogs.touchPull(connId, STAMP);
  const page = await linkedPage(bookId, connId, 51, '<p>Bleibt gleich.</p><p>Wird geaendert.</p>');
  const before = (await contentStore.loadPage(page.id)).html;
  const keepBid = /<p data-bid="([0-9a-f]+)">Bleibt gleich\.<\/p>/.exec(before)?.[1];
  assert.ok(keepBid, `Seite traegt Block-IDs: ${before}`);
  // Abgeglichen NACH dem Anlegen: lokal unveraendert, nur WordPress ist neuer.
  blogs.markLinkPulled(page.id, { wpModifiedAt: STAMP, wpStatus: 'publish', pulledAt: new Date(Date.now() + 1).toISOString() });
  const wp = makeWpStub({ posts: [post(51, '<p>alt</p>')] });
  wp.edit(51, { content: { raw: '<!-- wp:paragraph --><p>Bleibt gleich.</p><!-- /wp:paragraph --><!-- wp:paragraph --><p>Drueben neu geschrieben.</p><!-- /wp:paragraph -->' } });
  const restore = installFetch(wp);
  try {
    const job = await runJob('blog-pull', bookId, (id) => blogSync.runBlogPullJob(id, bookId, null));
    assert.equal(job.status, 'done', JSON.stringify(job.error));
    assert.equal(job.result.updated, 1);
    const after = (await contentStore.loadPage(page.id)).html;
    assert.match(after, new RegExp(`<p data-bid="${keepBid}">Bleibt gleich\\.</p>`));
    assert.match(after, /Drueben neu geschrieben/);
  } finally {
    restore();
  }
});
