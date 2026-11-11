'use strict';
// WordPress-Sync: Classic-Absaetze, Format-Sperre, Codeblock, relative Bilder,
// „schon im Blog", Wieder-Anschluss beim Import, Delta-Cursor, Passwort beim
// Test, Redirects, Post-Datum, Pagination, Lesefelder + Status, Reparatur.
// Ein Test (bzw. Testblock) je Befund; Doku: docs/blog-sync.md.
const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('wp-sync-fixes');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-1234567890abcdef';
// Mock-WP auf Reserved-TLD-Host (wp.test): DNS im SSRF-Guard ueberspringen.
process.env.SSRF_SKIP_DNS_CHECK = '1';

// Schema zuerst: es fuehrt die Migrationen aus, bevor andere DB-Module Statements vorbereiten.
const schema = require('../../db/schema');
const { wpToAppHtml, wpLossyBlocks, appToWpHtml } = require('../../lib/wp-html');
const { isBlogHosted } = require('../../lib/wp-media');
const { createWpClient } = require('../../lib/wp-client');
const blogPull = require('../../lib/blog-pull');
const { makeWpStub, installFetch } = require('../integration/_helpers/mock-wp');

const squash = (s) => String(s).replace(/>\s+</g, '><').trim();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── 1. Classic-Posts ────────────────────────────────────────────────────────

test('Classic-Post: Leerzeile = Absatz, einzelner Umbruch = <br>, Push schreibt je Absatz einen Block', async () => {
  const raw = 'Erster Absatz\nzweite Zeile\n\nZweiter <strong>Absatz</strong>\n\n<ul>\n<li>Punkt</li>\n</ul>\n\nEnde';
  const app = await wpToAppHtml(raw);
  assert.equal(squash(app), '<p>Erster Absatz<br>zweite Zeile</p><p>Zweiter <strong>Absatz</strong></p><ul><li>Punkt</li></ul><p>Ende</p>');
  const pushed = appToWpHtml(app);
  assert.equal((pushed.match(/<!-- wp:paragraph -->/g) || []).length, 3);
  // Block-Post bleibt, wie er ist (kein zweites Einwickeln).
  const block = '<!-- wp:paragraph --><p>A\nB</p><!-- /wp:paragraph -->';
  assert.doesNotMatch(await wpToAppHtml(block), /<br>/);
});

test('Classic-Post: <!--more--> / <!--nextpage--> sperren den Push; im Block-Post nur wp:more', () => {
  assert.deepEqual(wpLossyBlocks('Anfang<!--more-->Rest'), ['more']);
  assert.deepEqual(wpLossyBlocks('Seite 1<!--nextpage-->Seite 2'), ['nextpage']);
  assert.deepEqual(wpLossyBlocks('<!-- wp:more --><!--more--><!-- /wp:more -->'), ['wp:more']);
});

// ── 2. Format-Attribute ─────────────────────────────────────────────────────

test('Format-Sperre: typische Gutenberg-/Classic-Ausgaben ohne sichtbaren Verlust sperren nicht', () => {
  const harmless = [
    '<!-- wp:paragraph --><p>Text</p><!-- /wp:paragraph -->',
    '<!-- wp:heading --><h2 class="wp-block-heading" id="anker">T</h2><!-- /wp:heading -->',
    '<!-- wp:image {"id":12,"sizeSlug":"large","linkDestination":"none"} --><figure class="wp-block-image size-large"><img src="https://b.test/a-1024x683.jpg" alt="" class="wp-image-12"/></figure><!-- /wp:image -->',
    '<!-- wp:list --><ul class="wp-block-list"><!-- wp:list-item --><li>x</li><!-- /wp:list-item --></ul><!-- /wp:list -->',
    '<!-- wp:table --><figure class="wp-block-table"><table class="has-fixed-layout"><tbody><tr><td class="has-text-align-center" data-align="center">1</td></tr></tbody></table></figure><!-- /wp:table -->',
    '<!-- wp:separator --><hr class="wp-block-separator has-alpha-channel-opacity"/><!-- /wp:separator -->',
    '<!-- wp:quote --><blockquote class="wp-block-quote"><!-- wp:paragraph --><p>Q</p><!-- /wp:paragraph --></blockquote><!-- /wp:quote -->',
    '<p><img class="alignnone size-medium wp-image-5" src="https://b.test/x-300x200.jpg" width="300" height="200"></p>',
    '<p><span style="font-weight: 400;">aus Google Docs kopiert</span></p>',
  ];
  for (const raw of harmless) assert.deepEqual(wpLossyBlocks(raw), [], raw);
  // Eigener Push mit Tabellen-Ausrichtung und Codeblock: nie gesperrt.
  const own = appToWpHtml('<table><tbody><tr><td data-align="right">1</td></tr></tbody></table><pre class="mermaid">graph TD;</pre><hr>');
  assert.deepEqual(wpLossyBlocks(own), []);
});

test('Format-Sperre: sichtbare Formate, die der Pull verwirft, sperren mit Grund', () => {
  const cases = [
    ['<!-- wp:paragraph {"align":"center"} --><p class="has-text-align-center">x</p><!-- /wp:paragraph -->', 'format:text-align'],
    ['<!-- wp:paragraph {"dropCap":true} --><p class="has-drop-cap">x</p><!-- /wp:paragraph -->', 'format:drop-cap'],
    ['<p>ein <mark style="background-color:rgba(0, 0, 0, 0)" class="has-inline-color has-vivid-red-color">rotes</mark> Wort</p>', 'format:color'],
    ['<!-- wp:paragraph {"fontSize":"large"} --><p class="has-large-font-size">x</p><!-- /wp:paragraph -->', 'format:font-size'],
    ['<!-- wp:image {"align":"center"} --><figure class="wp-block-image aligncenter"><img src="https://b.test/a.jpg"/></figure><!-- /wp:image -->', 'format:align'],
    ['<!-- wp:image {"width":"300px"} --><figure class="wp-block-image is-resized"><img src="https://b.test/a.jpg" style="width:300px"/></figure><!-- /wp:image -->', 'format:image-size'],
    ['<p style="text-align: center;">Classic zentriert</p>', 'format:text-align'],
    ['<ol start="3"><li>x</li></ol>', 'format:list-start'],
  ];
  for (const [raw, reason] of cases) assert.ok(wpLossyBlocks(raw).includes(reason), `${reason}: ${wpLossyBlocks(raw)}`);
});

// ── 3. Codeblock ────────────────────────────────────────────────────────────

test('Codeblock/Diagramm: Push mit <code>, Pull nimmt es ab, Round-Trip ist verlustfrei', async () => {
  const app = '<pre class="mermaid">graph TD;\n  A --&gt; B;</pre>';
  const pushed = appToWpHtml(app);
  assert.match(pushed, /<pre class="wp-block-code mermaid"><code>graph TD;\n {2}A --&gt; B;<\/code><\/pre>/);
  assert.equal(squash(await wpToAppHtml(pushed)), squash(app));
  assert.equal(squash(await wpToAppHtml('<!-- wp:code --><pre class="wp-block-code"><code>x &lt; y</code></pre><!-- /wp:code -->')), '<pre>x &lt; y</pre>');
});

// ── 4. Relative Bilder ──────────────────────────────────────────────────────

test('Pull: relative Bildadressen werden gegen die Blog-URL aufgeloest', async () => {
  const raw = '<!-- wp:image --><figure class="wp-block-image"><img src="/wp-content/uploads/a.jpg" alt="A"/></figure><!-- /wp:image -->'
    + '<!-- wp:image --><figure class="wp-block-image"><img src="https://cdn.test/b.jpg" alt="B"/></figure><!-- /wp:image -->';
  const app = await wpToAppHtml(raw, null, { baseUrl: 'https://blog.test/unterordner' });
  assert.match(app, /src="https:\/\/blog\.test\/wp-content\/uploads\/a\.jpg"/);
  assert.match(app, /src="https:\/\/cdn\.test\/b\.jpg"/);
  // Ohne Basis bleibt die Adresse stehen.
  assert.match(await wpToAppHtml(raw), /src="\/wp-content\/uploads\/a\.jpg"/);
});

// ── 5. „Schon im Blog" ──────────────────────────────────────────────────────

test('isBlogHosted: www/apex gleich, Jetpack-CDN mit eigenem Host, fremde Hosts nicht', () => {
  const blog = 'https://example.com';
  assert.ok(isBlogHosted(new URL('https://www.example.com/wp-content/a.jpg'), blog));
  assert.ok(isBlogHosted(new URL('http://example.com/wp-content/a.jpg'), blog));
  assert.ok(isBlogHosted(new URL('https://example.com/x.jpg'), 'https://www.example.com'));
  assert.ok(isBlogHosted(new URL('https://i2.wp.com/www.example.com/wp-content/a.jpg?w=600'), blog));
  assert.equal(isBlogHosted(new URL('https://i2.wp.com/other.org/a.jpg'), blog), false);
  assert.equal(isBlogHosted(new URL('https://cdn.example.com/a.jpg'), blog), false);
  assert.equal(isBlogHosted(new URL('https://notexample.com/a.jpg'), blog), false);
});

// ── 10. Post-Datum ──────────────────────────────────────────────────────────

test('Post-Datum: Ortszeit (`date`), nicht UTC — Neujahrsmorgen bleibt im neuen Jahr', () => {
  const post = { date: '2026-01-01T00:30:00', date_gmt: '2025-12-31T23:30:00' };
  assert.equal(blogPull.postDay(post), '2026-01-01');
  assert.equal(blogPull.postYear(post), '2026');
  assert.equal(blogPull.postDay({ date_gmt: '2025-12-31T23:30:00' }), '2025-12-31');
});

// ── 7. Delta-Cursor ─────────────────────────────────────────────────────────

test('pullCursor: frueherer von App-Start und juengstem WP-Stempel minus Marge', () => {
  const m = blogPull.PULL_CURSOR_MARGIN_MS;
  // WP-Uhr geht nach: der WP-Stempel bestimmt.
  assert.equal(blogPull.pullCursor({ lastPullAt: '2026-05-01T12:00:00.000Z', maxSeenModifiedGmt: '2026-05-01T11:50:00' }),
    new Date(Date.parse('2026-05-01T11:50:00Z') - m).toISOString());
  // Zukunftsstempel (Migration): der App-Start deckelt.
  assert.equal(blogPull.pullCursor({ lastPullAt: '2026-05-01T12:00:00.000Z', maxSeenModifiedGmt: '2030-01-01T00:00:00' }),
    '2026-05-01T12:00:00.000Z');
  assert.equal(blogPull.pullCursor({ lastPullAt: '2026-05-01T12:00:00.000Z', maxSeenModifiedGmt: null }), '2026-05-01T12:00:00.000Z');
  assert.equal(blogPull.pullCursor({ lastPullAt: null, maxSeenModifiedGmt: '2026-05-01T11:50:00' }), undefined);
});

// ── 9. Redirects + 12. Lesefelder ──────────────────────────────────────────

function res(status, body = {}, headers = {}) {
  const hdr = new Map(Object.entries(headers));
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => hdr.get(k) ?? hdr.get(String(k).toLowerCase()) ?? null },
    text: async () => text,
    arrayBuffer: async () => { const b = Buffer.from(text); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
  };
}

test('Redirect: Push auf 3xx → BLOG_REDIRECT mit Zieladresse; 401 nach Cross-Origin-Redirect ebenso', async () => {
  const post = createWpClient({
    baseUrl: 'https://b.test', username: 'u', password: 'p',
    fetch: async () => res(301, {}, { location: 'https://www.b.test/wp-json/wp/v2/posts' }),
  });
  await assert.rejects(post.createPost({ title: 'x' }), (e) => e.code === 'BLOG_REDIRECT' && e.location === 'https://www.b.test');

  const calls = [];
  const get = createWpClient({
    baseUrl: 'https://b.test', username: 'u', password: 'p',
    fetch: async (url, init) => {
      calls.push({ url, auth: init.headers?.Authorization || init.headers?.authorization || null });
      return url.startsWith('https://b.test/')
        ? res(301, {}, { location: 'https://www.b.test/wp-json/wp/v2/users/me?context=edit' })
        : res(401, { code: 'rest_not_logged_in' });
    },
  });
  await assert.rejects(get.me(), (e) => e.code === 'BLOG_REDIRECT' && e.location === 'https://www.b.test');
  assert.equal(calls[1].auth, null, 'Anmeldung geht nicht an die fremde Origin');

  // Ohne Redirect bleibt 401 „Zugang abgelehnt".
  const plain = createWpClient({ baseUrl: 'https://b.test', username: 'u', password: 'p', fetch: async () => res(401) });
  await assert.rejects(plain.me(), { code: 'BLOG_AUTH_FAILED' });
});

test('listPosts liest link + featured_media mit', async () => {
  let seen = '';
  const wp = createWpClient({
    baseUrl: 'https://b.test', username: 'u', password: 'p',
    fetch: async (url) => { seen = url; return res(200, [], { 'X-WP-TotalPages': '1' }); },
  });
  await wp.listPosts({});
  const fields = new URL(seen).searchParams.get('_fields').split(',');
  for (const f of ['status', 'date', 'link', 'excerpt', 'featured_media']) assert.ok(fields.includes(f), f);
});

// ── 11. Kleinkram ───────────────────────────────────────────────────────────

test('i18n: BLOG_INVALID_STATUS und BLOG_REDIRECT in beiden Locales', () => {
  for (const loc of ['de', 'en']) {
    const data = require(`../../public/js/i18n/${loc}.json`);
    for (const k of ['blog.error.BLOG_INVALID_STATUS', 'blog.error.BLOG_REDIRECT', 'blog.error.BLOG_REDIRECT_TO', 'blog.connect.targetChangeConfirm']) {
      assert.ok(data[k], `${loc}: ${k}`);
    }
  }
});

// ── DB-gestuetzt: Import, Pull, Test-Passwort, Reparatur ────────────────────

const blogs = require('../../db/blogs');
const contentStore = require('../../lib/content-store');
const { jobs } = require('../../routes/jobs/shared');
const blogSync = require('../../routes/jobs/blog-sync');

function seedBlogBook(bookId) {
  schema.upsertBookByName(bookId, `WP-Fix-${bookId}`);
  schema.saveBookSettings(bookId, {
    language: 'de', region: 'CH', buchtyp: 'blog', buch_kontext: null, erzaehlperspektive: null,
    erzaehlzeit: null, is_finished: 0, allow_lektor_book_chat: 0,
  });
  return blogs.upsertConnection({ bookId, baseUrl: 'https://wp.test', username: 'editor', password: 'pw' });
}

async function runJob(type, fn, bookId, ...args) {
  const jobId = `${type}-${bookId}-${Date.now()}-${Math.random()}`;
  jobs.set(jobId, { id: jobId, type, bookId: String(bookId), userEmail: null, status: 'running', progress: 0, result: null, error: null });
  await fn(jobId, bookId, null, ...args);
  return jobs.get(jobId);
}

const wpPost = (id, title, raw, extra = {}) => ({
  id, title: { raw: title, rendered: title }, content: { raw, rendered: raw }, status: 'publish', slug: `p-${id}`,
  modified_gmt: '2026-04-01T10:00:00', date_gmt: '2026-04-01T10:00:00', date: '2026-04-01T12:00:00', ...extra,
});

test('Import nach Zielwechsel: gleichnamige Abschnitte werden wieder verknuepft statt verdoppelt', async () => {
  const bookId = 9701;
  const conn = seedBlogBook(bookId);
  const same = await contentStore.createPage({ book_id: bookId, name: '2026-04-01: Eins', html: '<p>Hallo Welt.</p>' }, null);
  const diff = await contentStore.createPage({ book_id: bookId, name: 'Zwei', html: '<p>Lokal anders.</p>' }, null);
  const wp = makeWpStub({ posts: [
    wpPost(11, 'Eins', '<!-- wp:paragraph --><p>Hallo Welt.</p><!-- /wp:paragraph -->'),
    wpPost(12, 'Zwei', '<!-- wp:paragraph --><p>Im Blog.</p><!-- /wp:paragraph -->'),
    wpPost(13, 'Drei', '<!-- wp:paragraph --><p>Neu.</p><!-- /wp:paragraph -->'),
  ] });
  const restore = installFetch(wp);
  try {
    const job = await runJob('blog-import', blogSync.runBlogImportJob, bookId);
    assert.equal(job.status, 'done', job.error || '');
    assert.equal(job.result.relinked, 2);
    assert.equal(job.result.relinkConflicts, 1);
    assert.equal(job.result.imported, 1);
    assert.equal(blogs.getLinkByPage(same.id).wp_post_id, 11);
    assert.equal(blogs.getLinkByPage(same.id).conflict_state, null);
    assert.equal(blogs.getLinkByPage(diff.id).wp_post_id, 12);
    assert.equal(blogs.getLinkByPage(diff.id).conflict_state, 'detected');
    assert.equal((await contentStore.listPages(bookId)).length, 3);
    assert.equal(conn.id, blogs.getConnection(bookId).id);
  } finally { restore(); }
});

test('Pull-Create: neuer Post ohne Link haengt sich an einen gleichnamigen Abschnitt', async () => {
  const bookId = 9705;
  const conn = seedBlogBook(bookId);
  const wp = makeWpStub({ posts: [wpPost(41, 'Erster', '<!-- wp:paragraph --><p>a</p><!-- /wp:paragraph -->')] });
  const restore = installFetch(wp);
  try {
    assert.equal((await runJob('blog-import', blogSync.runBlogImportJob, bookId)).status, 'done');
    // In der App entstanden, auf anderem Weg in den Blog gekommen.
    const local = await contentStore.createPage({ book_id: bookId, name: 'Zweiter', html: '<p>Gleicher Text.</p>' }, null);
    wp.posts.push(wpPost(42, 'Zweiter', '<!-- wp:paragraph --><p>Gleicher Text.</p><!-- /wp:paragraph -->',
      { modified_gmt: new Date(Date.now() + 1000).toISOString().slice(0, 19) }));
    blogs.touchPull(conn.id, '2000-01-01T00:00:00.000Z');
    const pull = await runJob('blog-pull', blogSync.runBlogPullJob, bookId);
    assert.equal(pull.status, 'done', pull.error || '');
    assert.equal(pull.result.relinked, 1);
    assert.equal(pull.result.created, 0);
    assert.equal(blogs.getLinkByPage(local.id).wp_post_id, 42);
    assert.equal(blogs.getLinkByPage(local.id).conflict_state, null);
    assert.equal((await contentStore.listPages(bookId)).length, 2);
  } finally { restore(); }
});

test('Pull: wp_status wird bei jedem gesehenen Post nachgezogen, auch ohne Inhaltsaenderung', async () => {
  const bookId = 9702;
  const conn = seedBlogBook(bookId);
  const wp = makeWpStub({ posts: [wpPost(21, 'Status', '<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->', { status: 'draft' })] });
  const restore = installFetch(wp);
  try {
    assert.equal((await runJob('blog-import', blogSync.runBlogImportJob, bookId)).status, 'done');
    const page = (await contentStore.listPages(bookId))[0];
    assert.equal(blogs.getLinkByPage(page.id).wp_status, 'draft');
    wp.posts[0].status = 'publish';           // per Zeitplan veroeffentlicht: modified bleibt
    blogs.touchPull(conn.id, '2000-01-01T00:00:00.000Z');
    const pull = await runJob('blog-pull', blogSync.runBlogPullJob, bookId);
    assert.equal(pull.status, 'done', pull.error || '');
    assert.equal(blogs.getLinkByPage(page.id).wp_status, 'publish');
  } finally { restore(); }
});

test('Pagination: 400 jenseits der letzten Seite ist das Listenende, nicht ein Fehler', async () => {
  const err = Object.assign(new Error('BLOG_HTTP_400'), { code: 'BLOG_HTTP_400', body: '{"code":"rest_post_invalid_page_number"}' });
  const wp = { listPosts: async ({ page }) => { if (page > 1) throw err; return { posts: [], totalPages: 2 }; } };
  assert.deepEqual((await blogSync._listPage(wp, { page: 2 })).posts, []);
  await assert.rejects(blogSync._listPage({ listPosts: async () => { throw err; } }, { page: 1 }), { code: 'BLOG_HTTP_400' });
});

test('Verbindung testen: leeres Passwort nimmt das gespeicherte — nur bei gleicher URL + Benutzer', () => {
  const blogRoutes = require('../../routes/blog');
  const bookId = 9703;
  seedBlogBook(bookId);
  const pw = blogRoutes._effectivePassword;
  assert.deepEqual(pw(bookId, 'https://wp.test', 'editor', ''), { password: 'pw' });
  assert.deepEqual(pw(bookId, 'https://wp.test', 'editor', '__keep__'), { password: 'pw' });
  assert.deepEqual(pw(bookId, 'https://evil.test', 'editor', ''), { error_code: 'BLOG_PASSWORD_REQUIRED_TARGET_CHANGED' });
  assert.deepEqual(pw(bookId, 'https://wp.test', 'editor', 'neu'), { password: 'neu' });
  assert.deepEqual(pw(9799, 'https://wp.test', 'editor', ''), { error_code: 'BLOG_CREDENTIALS_REQUIRED' });
});

test('repullPages: zieht zerstoerte Classic-Abschnitte neu, laesst lokal geaenderte stehen', async () => {
  const bookId = 9704;
  const conn = seedBlogBook(bookId);
  const classic = 'Absatz eins.\n\nAbsatz zwei.';
  const wp = makeWpStub({ posts: [wpPost(31, 'Classic', classic), wpPost(32, 'Lokal', classic)] });
  const restore = installFetch(wp);
  try {
    // Stand eines frueheren Imports ohne Absatzbildung: ein einziger Absatz.
    const broken = await contentStore.createPage({ book_id: bookId, name: '2026-04-01: Classic', html: '<p>Absatz eins. Absatz zwei.</p>' }, null);
    const edited = await contentStore.createPage({ book_id: bookId, name: '2026-04-01: Lokal', html: '<p>Absatz eins. Absatz zwei.</p>' }, null);
    await sleep(5);
    for (const [page, id] of [[broken, 31], [edited, 32]]) {
      blogs.upsertLink({ pageId: page.id, blogId: conn.id, wpPostId: id, wpModifiedAt: '2026-04-01T10:00:00', lastPulledAt: new Date().toISOString() });
    }
    await sleep(5);
    await contentStore.savePage(edited.id, { html: '<p>Lokal weitergeschrieben.</p>' }, null);

    const r = await blogPull.repullPages({ bookId, pageIds: [broken.id, edited.id, 999999] });
    assert.deepEqual(r.repulled, [broken.id]);
    assert.deepEqual(r.skipped.map(s => s.reason).sort(), ['LOCAL_CHANGES', 'NOT_LINKED']);
    assert.equal(squash((await contentStore.loadPage(broken.id)).html).replace(/ data-bid="[^"]*"/g, ''), '<p>Absatz eins.</p><p>Absatz zwei.</p>');
    assert.match((await contentStore.loadPage(edited.id)).html, /Lokal weitergeschrieben/);
    const { db } = require('../../db/connection');
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM page_revisions WHERE page_id = ?').get(broken.id).n >= 2, 'alter und neuer Stand als Revision');
  } finally { restore(); }
});
