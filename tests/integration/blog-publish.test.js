'use strict';
// Blog-Sync (WordPress): Push-Dialog-Pfade gegen den Mock-WP.
//   - «veroeffentlichen»: Push, dann status=publish; der neue modified_gmt gilt
//     als gesehen (der naechste Push meldet keinen Konflikt).
//   - «planen»: status=future + date_gmt (UTC, ohne Zone).
//   - Slug aus dem Titel nur beim Anlegen.
//   - Alt-Text eines hochgeladenen Bildes landet in der Mediathek.
//   - Abgleich: nur geloeschte Medien fliegen aus dem Bild-Cache.

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
  `).run(bookId, `Blog-Publish-${bookId}`);
  ctx.dbSchema.saveBookSettings(bookId, { language: 'de', region: 'CH', buchtyp: 'blog', buch_kontext: null, erzaehlperspektive: null, erzaehlzeit: null, is_finished: 0, allow_lektor_book_chat: 0 });
  blogs.upsertConnection({ bookId, baseUrl: 'https://wp.test', username: 'editor', password: 'pw', defaultStatus: 'draft' });
  return blogs.getConnection(bookId).id;
}

function runJob(type, bookId, fn) {
  const jobId = `test-${type}-${Date.now()}-${Math.random()}`;
  const { jobs, runningJobs } = ctx.shared;
  jobs.set(jobId, { id: jobId, type, bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
  runningJobs.set(jobId, { type, bookId });
  return fn(jobId).then(() => jobs.get(jobId));
}

const push = (bookId, pageIds, publish = null) =>
  runJob('blog-push', bookId, (jobId) => blogSync.runBlogPushJob(jobId, bookId, null, pageIds, publish));

test('veroeffentlichen: Push legt an, schaltet live, Slug aus dem Titel; naechster Push ohne Konflikt', async () => {
  const bookId = 9301;
  seedBlogBook(bookId);
  const wp = makeWpStub();
  const restore = installFetch(wp);
  try {
    const page = await contentStore.createPage({ book_id: bookId, chapter_id: null, name: 'Mein neuer Beitrag', html: '<p>Text</p>' }, null);
    const job = await push(bookId, [page.id], { mode: 'now' });
    assert.equal(job.status, 'done', `got ${job.status}: ${job.error || ''}`);
    assert.equal(job.result.published, 1);
    const post = wp.posts[0];
    assert.equal(post.status, 'publish');
    assert.equal(post.slug, 'mein-neuer-beitrag');
    const link = blogs.getLinkByPage(page.id);
    assert.equal(link.wp_status, 'publish');
    assert.equal(link.wp_modified_at, post.modified_gmt, 'eigener Statuswechsel gilt als gesehen');

    await contentStore.savePage(page.id, { html: '<p>Text, ergaenzt</p>' }, null);
    const again = await push(bookId, [page.id]);
    assert.equal(again.status, 'done', `got ${again.status}: ${again.error || ''}`);
    assert.equal(again.result.conflictSkipped, 0);
  } finally { restore(); }
});

test('planen: status=future mit date_gmt in UTC', async () => {
  const bookId = 9302;
  seedBlogBook(bookId);
  const wp = makeWpStub();
  const restore = installFetch(wp);
  try {
    const page = await contentStore.createPage({ book_id: bookId, chapter_id: null, name: 'Geplant', html: '<p>Bald</p>' }, null);
    const at = new Date(Date.now() + 2 * 86400_000);
    at.setUTCMilliseconds(0);
    const job = await push(bookId, [page.id], { mode: 'schedule', at: at.toISOString() });
    assert.equal(job.status, 'done', `got ${job.status}: ${job.error || ''}`);
    assert.equal(wp.posts[0].status, 'future');
    assert.equal(wp.posts[0].date_gmt, at.toISOString().slice(0, 19));
    assert.equal(blogs.getLinkByPage(page.id).wp_status, 'future');
  } finally { restore(); }
});

test('Bild-Upload: Alt-Text landet in der Mediathek; Abgleich verwirft nur geloeschte Medien', async () => {
  const bookId = 9303;
  seedBlogBook(bookId);
  const wp = makeWpStub();
  const restore = installFetch(wp);
  try {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const page = await contentStore.createPage({ book_id: bookId, chapter_id: null, name: 'Bild', html: `<p>x</p><img src="${png}" alt="Ein Hund">` }, null);
    const job = await push(bookId, [page.id]);
    assert.equal(job.status, 'done', `got ${job.status}: ${job.error || ''}`);
    assert.equal(wp.media.length, 1);
    assert.equal(wp.media[0].alt_text, 'Ein Hund');

    const { listCachedMedia } = require('../../db/sync-media-cache');
    const owner = { blogId: blogs.getConnection(bookId).id };
    assert.equal(listCachedMedia(owner).length, 1);
    const recon = await runJob('blog-reconcile', bookId, (jobId) => blogSync.runBlogReconcileJob(jobId, bookId, null));
    assert.equal(recon.status, 'done', `got ${recon.status}: ${recon.error || ''}`);
    assert.equal(listCachedMedia(owner).length, 1, 'lebendes Medium bleibt im Cache');

    wp.media.splice(0, 1);
    await runJob('blog-reconcile', bookId, (jobId) => blogSync.runBlogReconcileJob(jobId, bookId, null));
    assert.equal(listCachedMedia(owner).length, 0, 'geloeschtes Medium fliegt raus');
  } finally { restore(); }
});

test('Reparatur «Unbearbeitete neu einlesen»: Classic-Textwand bekommt ihre Absaetze zurueck, lokal Bearbeitetes bleibt', async () => {
  const bookId = 9304;
  const connId = seedBlogBook(bookId);
  const STAMP = '2026-04-01T10:00:00';
  const classic = 'Erster Absatz.\n\nZweiter Absatz.';
  const wp = makeWpStub({
    posts: [41, 42].map(id => ({
      id, title: { rendered: `Post ${id}`, raw: `Post ${id}` },
      content: { rendered: classic, raw: classic },
      status: 'publish', slug: `post-${id}`, modified_gmt: STAMP, date_gmt: STAMP, date: STAMP,
    })),
  });
  const restore = installFetch(wp);
  try {
    const mk = async (wpPostId, html) => {
      const page = await contentStore.createPage({ book_id: bookId, chapter_id: null, name: `2026-04-01: Post ${wpPostId}`, html }, null);
      blogs.upsertLink({ pageId: page.id, blogId: connId, wpPostId, wpModifiedAt: STAMP, wpStatus: 'publish', lastPulledAt: new Date(Date.now() + 1000).toISOString() });
      return page;
    };
    const broken = await mk(41, '<p>Erster Absatz. Zweiter Absatz.</p>');
    const edited = await mk(42, '<p>Erster Absatz. Zweiter Absatz.</p>');
    // Lokale Bearbeitung NACH dem Sync-Punkt → wird uebersprungen.
    await new Promise(r => setTimeout(r, 1100));
    await contentStore.savePage(edited.id, { html: '<p>Von Hand repariert.</p>' }, null);

    const job = await runJob('blog-repull', bookId, (jobId) => blogSync.runBlogRepullJob(jobId, bookId, null));
    assert.equal(job.status, 'done', `got ${job.status}: ${job.error || ''}`);
    assert.equal(job.result.repulled, 1);
    assert.deepEqual(job.result.toastWarnings, [{ key: 'sync.repull.skipped', n: 1 }]);
    const fixed = await contentStore.loadPage(broken.id);
    assert.equal(((fixed.html || fixed.body_html).match(/<p[\s>]/g) || []).length, 2, 'zwei Absaetze');
    const kept = await contentStore.loadPage(edited.id);
    assert.match(kept.html || kept.body_html, /Von Hand repariert/);
  } finally { restore(); }
});
