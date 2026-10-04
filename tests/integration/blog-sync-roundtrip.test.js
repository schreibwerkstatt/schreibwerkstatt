'use strict';
// Round-Trip-Faelle des WordPress-Syncs, die ueber mehrere Jobs laufen:
// Push → Aenderung in WordPress → Pull (kein falscher Konflikt), Push-Pre-Check
// gegen ungesehene WP-Aenderungen, Konflikt „App gewinnt", Import-Wiederaufnahme
// und die Titel-Wege (Entities, Datums-Praefix, Titel-Werkstatt inkl. Lead und
// Teaser). Mock-WP: tests/integration/_helpers/mock-wp.js.

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
let headline;

test.before(() => {
  ctx = bootstrap();
  blogSync = require('../../routes/jobs/blog-sync');
  blogs = require('../../db/blogs');
  contentStore = require('../../lib/content-store');
  headline = require('../../db/headline');
});
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.dbSeed.reset();
  const { db } = require('../../db/connection');
  db.prepare('DELETE FROM blog_page_links').run();
  db.prepare('DELETE FROM blog_connections').run();
});

function seedBlogBook(bookId) {
  const { db } = require('../../db/connection');
  db.prepare(`
    INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(book_id) DO UPDATE SET name=excluded.name
  `).run(bookId, `Blog-Test-${bookId}`);
  ctx.dbSchema.saveBookSettings(bookId, 'de', 'CH', 'blog', null, null, null, 0, 0);
  blogs.upsertConnection({
    bookId, baseUrl: 'https://wp.test', username: 'editor', password: 'pw', defaultStatus: 'draft',
  });
  return blogs.getConnection(bookId).id;
}

async function run(type, fn, bookId) {
  const jobId = `test-${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { jobs, runningJobs } = ctx.shared;
  jobs.set(jobId, { id: jobId, type, bookId, userEmail: null, status: 'running', progress: 0, createdAt: Date.now() });
  runningJobs.set(jobId, { type, bookId });
  await fn(jobId);
  const job = jobs.get(jobId);
  assert.equal(job.status, 'done', JSON.stringify(job.error));
  return job.result;
}

const push = (bookId, ids) => run('blog-push', id => blogSync.runBlogPushJob(id, bookId, null, ids), bookId);
const pull = bookId => run('blog-pull', id => blogSync.runBlogPullJob(id, bookId, null), bookId);
const tick = () => new Promise(r => setTimeout(r, 15));

test('Push-Create → Edit in WordPress → Pull: Update statt Konflikt, Datums-Praefix bleibt', async () => {
  const bookId = 9101;
  const connId = seedBlogBook(bookId);
  blogs.markInitialImportDone(connId);
  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null, name: 'Neuer Beitrag', html: '<p>Erste Fassung.</p>',
  }, null);

  const wp = makeWpStub();
  const restore = installFetch(wp);
  try {
    const r1 = await push(bookId, [page.id]);
    assert.equal(r1.createdRemote, 1);
    const localName = r1.renamed[0].name;
    assert.match(localName, /^\d{4}-\d{2}-\d{2}: Neuer Beitrag$/);
    const postId = blogs.getLinkByPage(page.id).wp_post_id;
    assert.equal(wp.posts[0].title.raw, 'Neuer Beitrag', 'WP-Titel ohne Datum');

    wp.edit(postId, {
      title: { raw: 'Umbenannt in WP', rendered: 'Umbenannt in WP' },
      content: { raw: '<p>In WP bearbeitet.</p>', rendered: '<p>In WP bearbeitet.</p>' },
    });
    const r2 = await pull(bookId);
    assert.equal(r2.conflicts, 0, 'per Push angelegte Seite darf beim Pull nicht in Konflikt laufen');
    assert.equal(r2.updated, 1);

    const after = await contentStore.loadPage(page.id);
    assert.match(after.html, /In WP bearbeitet/);
    assert.equal(after.name, localName.replace('Neuer Beitrag', 'Umbenannt in WP'), 'lokaler Datums-Praefix bleibt stehen');
    assert.deepEqual(r2.renamed, [{ pageId: page.id, name: after.name }]);
    assert.equal(blogs.getLinkByPage(page.id).conflict_state, null);
  } finally { restore(); }
});

test('Lokaler Edit → Push → Edit in WordPress → Pull: Update statt Konflikt', async () => {
  const bookId = 9102;
  const connId = seedBlogBook(bookId);
  blogs.markInitialImportDone(connId);
  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null, name: '2026-01-01: Beitrag', html: '<p>alt</p>',
  }, null);
  const wp = makeWpStub({
    posts: [{
      id: 31, title: { raw: 'Beitrag', rendered: 'Beitrag' },
      content: { raw: '<p>alt</p>', rendered: '<p>alt</p>' }, status: 'publish', slug: 'beitrag',
      modified_gmt: '2026-01-01T10:00:00', date_gmt: '2026-01-01T10:00:00',
    }],
  });
  blogs.upsertLink({
    pageId: page.id, blogId: connId, wpPostId: 31, wpModifiedAt: '2026-01-01T10:00:00',
    lastPulledAt: '2026-01-01T10:00:00.000Z',
  });
  const restore = installFetch(wp);
  try {
    await tick();
    await contentStore.savePage(page.id, { html: '<p>lokal neu</p>' }, null);
    const r1 = await push(bookId, [page.id]);
    assert.equal(r1.pushed, 1);

    wp.edit(31, { content: { raw: '<p>WP neu</p>', rendered: '<p>WP neu</p>' } });
    const r2 = await pull(bookId);
    assert.equal(r2.conflicts, 0);
    assert.equal(r2.updated, 1);
  } finally { restore(); }
});

test('Push-Pre-Check: ungesehene Aenderung in WordPress → Konflikt, WP bleibt unangetastet', async () => {
  const bookId = 9103;
  const connId = seedBlogBook(bookId);
  blogs.markInitialImportDone(connId);
  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null, name: 'Beitrag', html: '<p>App-Stand</p>',
  }, null);
  const wp = makeWpStub({
    posts: [{
      id: 41, title: { raw: 'Beitrag', rendered: 'Beitrag' },
      content: { raw: '<p>alt</p>', rendered: '<p>alt</p>' }, status: 'publish', slug: 'b',
      modified_gmt: '2026-01-01T10:00:00', date_gmt: '2026-01-01T10:00:00',
    }],
  });
  blogs.upsertLink({
    pageId: page.id, blogId: connId, wpPostId: 41, wpModifiedAt: '2026-01-01T10:00:00',
    lastPulledAt: '2026-01-01T10:00:00.000Z',
  });
  const restore = installFetch(wp);
  try {
    wp.edit(41, { content: { raw: '<p>WP-Edit</p>', rendered: '<p>WP-Edit</p>' } });
    const r = await push(bookId, [page.id]);
    assert.equal(r.pushed, 0);
    assert.equal(r.conflictSkipped, 1);
    assert.deepEqual(r.errors, [{ pageId: page.id, code: 'BLOG_CONFLICT' }]);
    assert.equal(blogs.getLinkByPage(page.id).conflict_state, 'detected');
    assert.equal(wp.posts[0].content.raw, '<p>WP-Edit</p>', 'WP-Edit nicht ueberschrieben');
    assert.equal(wp.calls.filter(c => c.method === 'POST').length, 0, 'kein Schreib-Call');

    // „App gewinnt": der gesehene WP-Stand gilt als bekannt → Pull meldet keinen
    // Konflikt mehr, der Push geht durch.
    blogs.markConflictResolvedApp(page.id, wp.posts[0].modified_gmt);
    const rp = await pull(bookId);
    assert.equal(rp.conflicts, 0);
    assert.equal(rp.updated, 0, 'App-Stand bleibt');
    const r2 = await push(bookId, [page.id]);
    assert.equal(r2.pushed, 1);
    assert.match(wp.posts[0].content.raw, /App-Stand/);
  } finally { restore(); }
});

test('Initial-Import nach Abbruch: bereits verlinkte Posts werden uebersprungen', async () => {
  const bookId = 9104;
  const connId = seedBlogBook(bookId);
  const early = await contentStore.createPage({
    book_id: bookId, chapter_id: null, name: '2026-01-01: Eins', html: '<p>1</p>',
  }, null);
  blogs.upsertLink({ pageId: early.id, blogId: connId, wpPostId: 51, wpModifiedAt: '2026-01-01T10:00:00' });
  const wp = makeWpStub({
    posts: [51, 52].map(id => ({
      id, title: { raw: `Post ${id}`, rendered: `Post ${id}` },
      content: { raw: `<p>${id}</p>`, rendered: `<p>${id}</p>` }, status: 'publish', slug: `p${id}`,
      modified_gmt: '2026-01-01T10:00:00', date_gmt: '2026-01-01T10:00:00',
    })),
  });
  const restore = installFetch(wp);
  try {
    const r = await run('blog-import', id => blogSync.runBlogImportJob(id, bookId, null), bookId);
    assert.equal(r.imported, 1);
    assert.equal(r.skipped, 1);
    assert.ok(blogs.getConnection(bookId).initialImportDoneAt);
    const pages = ctx.dbSchema.db.prepare('SELECT page_name FROM pages WHERE book_id = ?').all(bookId);
    assert.equal(pages.length, 2, 'keine verwaiste Doppel-Seite');
  } finally { restore(); }
});

test('Import: Titel nur als `rendered` → Entities dekodiert im Seitennamen', async () => {
  const bookId = 9105;
  seedBlogBook(bookId);
  const wp = makeWpStub({
    posts: [{
      id: 61, title: { rendered: 'Kafka&#8217;s Briefe &amp; Tageb&uuml;cher &#8211; neu' },
      content: { rendered: '<p>x</p>' }, status: 'publish', slug: 'k',
      modified_gmt: '2025-03-04T10:00:00', date_gmt: '2025-03-04T10:00:00',
    }],
  });
  const restore = installFetch(wp);
  try {
    await run('blog-import', id => blogSync.runBlogImportJob(id, bookId, null), bookId);
    const row = ctx.dbSchema.db.prepare('SELECT page_name FROM pages WHERE book_id = ?').get(bookId);
    assert.equal(row.page_name, '2025-03-04: Kafka’s Briefe & Tagebücher – neu');
  } finally { restore(); }
});

test('Titel-Werkstatt: Titel/Lead/Teaser gehen raus und kommen beim Pull in die Werkstatt zurueck', async () => {
  const bookId = 9106;
  const connId = seedBlogBook(bookId);
  blogs.markInitialImportDone(connId);
  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null, name: 'Arbeitstitel', html: '<p>Fliesstext.</p>',
  }, null);
  headline.setHeadline(page.id, bookId, { titel: 'Die Schlagzeile', lead: 'Der Lead.', teaser: 'Der Anreisser.' });

  const wp = makeWpStub();
  const restore = installFetch(wp);
  try {
    const r1 = await push(bookId, [page.id]);
    const localName = r1.renamed[0].name;
    const post = wp.posts[0];
    assert.equal(post.title.raw, 'Die Schlagzeile');
    assert.equal(post.excerpt.raw, 'Der Anreisser.');
    assert.match(post.content.raw, /^<!-- wp:group \{"className":"sw-headline"\} -->[\s\S]*Der Lead\.[\s\S]*Fliesstext/);

    wp.edit(post.id, {
      title: { raw: 'Neue Schlagzeile', rendered: 'Neue Schlagzeile' },
      content: {
        raw: post.content.raw.replace('Der Lead.', 'Neuer Lead.'),
        rendered: '',
      },
      excerpt: { raw: 'Neuer Anreisser.', rendered: '' },
    });
    const r2 = await pull(bookId);
    assert.equal(r2.conflicts, 0);
    assert.equal(r2.updated, 1);

    const hl = headline.getHeadline(page.id);
    assert.equal(hl.titel, 'Neue Schlagzeile');
    assert.equal(hl.lead, 'Neuer Lead.');
    assert.equal(hl.teaser, 'Neuer Anreisser.');
    const after = await contentStore.loadPage(page.id);
    assert.equal(after.name, localName, 'Werkstatt-Titel da → Seitenname unberuehrt');
    assert.doesNotMatch(after.html, /Lead/, 'Lead nie im Fliesstext');
    assert.match(after.html, /Fliesstext/);

    // Zweiter Push: Werkstatt-Stand geht raus, Lead genau einmal im Post.
    await tick();
    await contentStore.savePage(page.id, { html: '<p>Fliesstext 2.</p>' }, null);
    await push(bookId, [page.id]);
    assert.equal(wp.posts[0].title.raw, 'Neue Schlagzeile');
    assert.equal((wp.posts[0].content.raw.match(/Neuer Lead\./g) || []).length, 1);
  } finally { restore(); }
});

test('Titel-Werkstatt komplett geleert → push-needed, Push traegt wieder den Seitennamen', async () => {
  const bookId = 9107;
  const connId = seedBlogBook(bookId);
  blogs.markInitialImportDone(connId);
  const page = await contentStore.createPage({
    book_id: bookId, chapter_id: null, name: 'Arbeitstitel', html: '<p>Text.</p>',
  }, null);
  headline.setHeadline(page.id, bookId, { titel: 'Schlagzeile', lead: 'Lead.' });

  const wp = makeWpStub();
  const restore = installFetch(wp);
  try {
    await push(bookId, [page.id]);
    assert.equal(wp.posts[0].title.raw, 'Schlagzeile');

    await tick();
    headline.setHeadline(page.id, bookId, { titel: '', lead: '' });
    assert.equal(headline.getHeadline(page.id), null);
    // Badge-Quelle: der Link traegt den Zeitpunkt des Leerens
    const link = blogs.listLinksForBlog(connId).find(l => l.page_id === page.id);
    assert.ok(link.headline_updated_at > link.last_pushed_at, 'Leeren zaehlt als lokaler Edit');

    await push(bookId, [page.id]);
    assert.equal(wp.posts[0].title.raw, 'Arbeitstitel');
    assert.doesNotMatch(wp.posts[0].content.raw, /sw-headline|Lead\./);
  } finally { restore(); }
});
