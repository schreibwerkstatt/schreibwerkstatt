'use strict';
// Integration: HubSpot-Initial-Import + Push-Job gegen Mock-HubSpot.
// Buchtyp 'blog' Pflicht; sonst HUBSPOT_REQUIRES_BLOG_TYPE.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-1234567890abcdef';

const { bootstrap, waitForJob } = require('./_helpers/setup');
const { makeMock } = require('./_helpers/mock-hubspot');

let ctx;
let mock;
let hubspot;
let hubspotSync;

test.before(() => {
  ctx = bootstrap();
  hubspot = require('../../db/hubspot');
  hubspotSync = require('../../routes/jobs/hubspot-sync');
});
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.dbSeed.reset();
  mock = makeMock();
});
test.afterEach(() => { mock.restore(); });

function seedBlogBook(bookId) {
  ctx.dbSeed.setBook({
    books: [{ id: bookId, name: `Test-Book-${bookId}` }],
    chapters: [], pages: [], pageBodies: {},
  });
  ctx.dbSchema.saveBookSettings(bookId, 'de', 'CH', 'blog', '', null, null, 0, 0, 1500);
}

test('hubspot-import: zwei PUBLISHED-Posts → Pages + Jahres-Kapitel + Link-Eintraege', async () => {
  const BOOK_ID = 70;
  seedBlogBook(BOOK_ID);
  hubspot.upsertConnection({ bookId: BOOK_ID, token: 'pat-x', blogId: '555', authorId: '111' });
  // Newest-first geliefert (HubSpot-Default) — Import muss aufsteigend sortieren.
  mock.state.posts = [
    {
      id: '1002', htmlTitle: 'Zweiter Beitrag | Mein Blog', name: 'Zweiter Beitrag',
      publishDate: '2025-01-02T10:00:00.000Z', state: 'PUBLISHED',
      postBody: '<p>Mehr Text</p>',
    },
    {
      id: '1001', htmlTitle: 'Erster Beitrag', name: 'Erster Beitrag',
      publishDate: '2024-03-15T10:00:00.000Z', state: 'PUBLISHED',
      postBody: '<p>Hallo Welt</p><img src="https://x/foo.png">',
    },
  ];

  const jobId = ctx.shared.createJob('hubspot-import', BOOK_ID, 'tester@test.dev', 'job.label.hubspotImport');
  ctx.shared.enqueueJob(jobId, () => hubspotSync.runHubspotImportJob(jobId, BOOK_ID, 'tester@test.dev'));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 6000 });
  assert.equal(job.status, 'done', `got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.imported, 2);

  const conn = hubspot.getConnection(BOOK_ID);
  assert.match(conn.initialImportDoneAt, /^\d{4}-/);

  const pages = ctx.dbSchema.db.prepare('SELECT page_id, page_name, chapter_id FROM pages WHERE book_id = ?').all(BOOK_ID);
  assert.equal(pages.length, 2);
  const names = pages.map(p => p.page_name).sort();
  assert.match(names[0], /^2024-03-15:/);
  // Titel aus `name`, nicht aus dem SEO-Titel `htmlTitle` (« | Blogname»).
  assert.equal(names[1], '2025-01-02: Zweiter Beitrag');

  const chapters = ctx.dbSchema.db.prepare('SELECT chapter_name FROM chapters WHERE book_id = ?').all(BOOK_ID);
  const chNames = chapters.map(c => c.chapter_name).sort();
  assert.deepEqual(chNames, ['2024', '2025']);

  // Reihenfolge: trotz newest-first-Lieferung landen Kapitel + Seiten in
  // Anlage-(=chronologischer)-Reihenfolge (page_id/chapter_id aufsteigend).
  const chOrder = ctx.dbSchema.db.prepare('SELECT chapter_name FROM chapters WHERE book_id = ? ORDER BY chapter_id').all(BOOK_ID);
  assert.deepEqual(chOrder.map(c => c.chapter_name), ['2024', '2025']);
  const pageOrder = ctx.dbSchema.db.prepare('SELECT page_name FROM pages WHERE book_id = ? ORDER BY page_id').all(BOOK_ID);
  assert.match(pageOrder[0].page_name, /^2024-03-15:/);
  assert.match(pageOrder[1].page_name, /^2025-01-02:/);

  // Bild im Body wurde gestrippt.
  const body = ctx.dbSchema.db.prepare('SELECT body_html FROM pages WHERE page_id = ?').get(pages[0].page_id);
  assert.doesNotMatch(body.body_html, /<img/);

  // Link-Eintraege existieren.
  const links = hubspot.listLinksForConnection(conn.id);
  assert.equal(links.length, 2);

  // Import setzt last_pushed_at als Sync-Baseline auf den Anlage-Zeitpunkt der
  // Page → Status direkt nach Import ist 'synced', nicht 'push-needed'.
  for (const link of links) {
    assert.ok(link.last_pushed_at, 'last_pushed_at muss nach Import gesetzt sein');
    const page = ctx.dbSchema.db.prepare('SELECT updated_at FROM pages WHERE page_id = ?').get(link.page_id);
    assert.ok(page.updated_at <= link.last_pushed_at, 'page.updated_at darf nicht ueber der Baseline liegen');
  }
});

test('hubspot-import: bereits importiert → HUBSPOT_ALREADY_IMPORTED', async () => {
  const BOOK_ID = 71;
  seedBlogBook(BOOK_ID);
  hubspot.upsertConnection({ bookId: BOOK_ID, token: 'pat-x', blogId: '555', authorId: '111' });
  hubspot.markInitialImportDone(hubspot.getConnection(BOOK_ID).id);

  const jobId = ctx.shared.createJob('hubspot-import', BOOK_ID, 'tester@test.dev', 'job.label.hubspotImport');
  ctx.shared.enqueueJob(jobId, () => hubspotSync.runHubspotImportJob(jobId, BOOK_ID, 'tester@test.dev'));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 4000 });
  assert.equal(job.status, 'error');
  assert.match(String(job.error || ''), /HUBSPOT_ALREADY_IMPORTED/);
});

test('hubspot-push: Erst-Push erstellt Draft + Link; Re-Push aktualisiert den Buffer (PATCH /draft)', async () => {
  const BOOK_ID = 72;
  seedBlogBook(BOOK_ID);
  hubspot.upsertConnection({ bookId: BOOK_ID, token: 'pat-x', blogId: '555', authorId: '111' });

  const contentStore = require('../../lib/content-store');
  const page = await contentStore.createPage(
    { book_id: BOOK_ID, name: 'Mein Eintrag', html: '<p>Inhalt</p>' },
    null,
  );

  const jobId = ctx.shared.createJob('hubspot-push', BOOK_ID, 'tester@test.dev', 'job.label.hubspotPushCount', { count: 1 });
  ctx.shared.enqueueJob(jobId, () => hubspotSync.runHubspotPushJob(jobId, BOOK_ID, 'tester@test.dev', [page.id]));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 4000 });
  assert.equal(job.status, 'done', `got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.createdRemote, 1);
  assert.equal(mock.state.created.length, 1);
  assert.equal(mock.state.created[0].state, 'DRAFT');
  assert.equal(mock.state.created[0].contentGroupId, '555');
  assert.equal(mock.state.created[0].blogAuthorId, '111');
  assert.equal(mock.state.created[0].authorName, 'Autor Eins');

  const link = hubspot.getLinkByPage(page.id);
  assert.ok(link);
  assert.equal(link.hubspot_state, 'DRAFT');
  const firstPostId = link.hubspot_post_id;
  const firstPushedAt = link.last_pushed_at;
  assert.ok(firstPushedAt);
  assert.equal(link.hubspot_updated_at, mock.state.created[0].updated, 'Draft-Stempel fuer die Vorab-Pruefung');

  // Page lokal ändern → Re-Push aktualisiert den Buffer via PATCH …/draft.
  await new Promise(r => setTimeout(r, 30)); // sicherstellen, dass updated_at > last_pushed_at
  await contentStore.savePage(page.id, { html: '<p>Geänderter Inhalt</p>' }, null);

  const jobId2 = ctx.shared.createJob('hubspot-push', BOOK_ID, 'tester@test.dev', 'job.label.hubspotPushCount', { count: 1 });
  ctx.shared.enqueueJob(jobId2, () => hubspotSync.runHubspotPushJob(jobId2, BOOK_ID, 'tester@test.dev', [page.id]));
  const job2 = await waitForJob(ctx.shared, jobId2, { timeoutMs: 4000 });
  assert.equal(job2.status, 'done', `got ${job2.status}: ${job2.error || ''}`);
  assert.equal(job2.result.pushed, 1);
  assert.equal(job2.result.errors.length, 0);
  // Kein zweiter create — PATCH statt POST.
  assert.equal(mock.state.created.length, 1);
  assert.equal(mock.state.updated.length, 1);
  assert.equal(mock.state.updated[0].id, firstPostId);
  assert.match(mock.state.updated[0].postBody, /Geänderter/);

  // Link bleibt auf derselben Post-ID, last_pushed_at wurde aktualisiert.
  const link2 = hubspot.getLinkByPage(page.id);
  assert.equal(link2.hubspot_post_id, firstPostId);
  assert.notEqual(link2.last_pushed_at, firstPushedAt);
});

test('hubspot-push: Buchtyp != blog → HUBSPOT_REQUIRES_BLOG_TYPE', async () => {
  const BOOK_ID = 73;
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: `Test-Book-${BOOK_ID}` }],
    chapters: [], pages: [], pageBodies: {},
  });
  ctx.dbSchema.saveBookSettings(BOOK_ID, 'de', 'CH', 'roman', '', null, null, 0, 0, 1500);

  const jobId = ctx.shared.createJob('hubspot-push', BOOK_ID, 'tester@test.dev', 'job.label.hubspotPushCount', { count: 1 });
  ctx.shared.enqueueJob(jobId, () => hubspotSync.runHubspotPushJob(jobId, BOOK_ID, 'tester@test.dev', [1]));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 4000 });
  assert.equal(job.status, 'error');
  assert.match(String(job.error || ''), /HUBSPOT_REQUIRES_BLOG_TYPE/);
});

test('hubspot-push: Titel ohne Datums-Praefix, Titel-Werkstatt gewinnt, Lead + Teaser gehen mit', async () => {
  const BOOK_ID = 74;
  seedBlogBook(BOOK_ID);
  hubspot.upsertConnection({ bookId: BOOK_ID, token: 'pat-x', blogId: '555', authorId: '111' });
  const contentStore = require('../../lib/content-store');
  const headline = require('../../db/headline');

  const plain = await contentStore.createPage(
    { book_id: BOOK_ID, name: '2025-01-02: Nur Seitenname', html: '<p>A</p>' }, null);
  const withHl = await contentStore.createPage(
    { book_id: BOOK_ID, name: '2025-01-03: Arbeitstitel', html: '<p>B</p>' }, null);
  headline.setHeadline(withHl.id, BOOK_ID, { titel: 'Die Schlagzeile', lead: 'Der Lead.', teaser: 'A & B' });

  const jobId = ctx.shared.createJob('hubspot-push', BOOK_ID, 'tester@test.dev', 'job.label.hubspotPushCount', { count: 2 });
  ctx.shared.enqueueJob(jobId, () => hubspotSync.runHubspotPushJob(jobId, BOOK_ID, 'tester@test.dev', [plain.id, withHl.id]));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 4000 });
  assert.equal(job.status, 'done', `got ${job.status}: ${job.error || ''}`);

  const [p1, p2] = mock.state.created.slice(-2);
  assert.equal(p1.name, 'Nur Seitenname');
  assert.equal(p1.htmlTitle, 'Nur Seitenname');
  assert.equal(p1.postSummary, undefined);
  assert.equal(p2.name, 'Die Schlagzeile');
  assert.equal(p2.htmlTitle, 'Die Schlagzeile');
  assert.equal(p2.postSummary, 'A &amp; B');
  assert.match(p2.postBody, /^<p><em>Der Lead\.<\/em><\/p>/);
});

// ── Gemeinsamer Sync-Kern: Vorab-Pruefung, Remote weg, Abgleich, Bilder ──────

async function pushJob(bookId, pageIds) {
  const jobId = ctx.shared.createJob('hubspot-push', bookId, 'tester@test.dev', 'job.label.hubspotPushCount', { count: pageIds.length });
  ctx.shared.enqueueJob(jobId, () => hubspotSync.runHubspotPushJob(jobId, bookId, 'tester@test.dev', pageIds));
  return waitForJob(ctx.shared, jobId, { timeoutMs: 4000 });
}

async function pushedPage(bookId, html = '<p>Inhalt</p>') {
  seedBlogBook(bookId);
  hubspot.upsertConnection({ bookId, token: 'pat-x', blogId: '555', authorId: '111' });
  const contentStore = require('../../lib/content-store');
  const page = await contentStore.createPage({ book_id: bookId, name: 'Eintrag', html }, null);
  const first = await pushJob(bookId, [page.id]);
  assert.equal(first.status, 'done', `got ${first.status}: ${first.error || ''}`);
  return { page, postId: hubspot.getLinkByPage(page.id).hubspot_post_id, contentStore };
}

test('hubspot-push: Draft in HubSpot geaendert → Konflikt, Buffer bleibt unangetastet', async () => {
  const BOOK_ID = 75;
  const { page, postId, contentStore } = await pushedPage(BOOK_ID);
  mock.editDraft(postId, { postBody: '<p>In HubSpot ergaenzt</p>' });
  await contentStore.savePage(page.id, { html: '<p>Lokal geaendert</p>' }, null);

  const job = await pushJob(BOOK_ID, [page.id]);
  assert.equal(job.status, 'error');
  assert.match(String(job.error || ''), /HUBSPOT_CONFLICT/);
  assert.equal(mock.state.updated.length, 0, 'kein PATCH auf den geaenderten Draft');
  assert.equal(hubspot.getLinkByPage(page.id).conflict_state, 'detected');

  // Erneuter Push bleibt gesperrt, bis der Konflikt geloest ist.
  const again = await pushJob(BOOK_ID, [page.id]);
  assert.equal(again.status, 'error');
  assert.equal(mock.state.updated.length, 0);

  // „App behalten": der gesehene Draft-Stand gilt als bekannt → Push geht durch.
  hubspot.markConflictResolvedApp(page.id, mock.state.drafts[postId].updated);
  const resolved = await pushJob(BOOK_ID, [page.id]);
  assert.equal(resolved.status, 'done', `got ${resolved.status}: ${resolved.error || ''}`);
  assert.equal(mock.state.updated.length, 1);
  assert.match(mock.state.updated[0].postBody, /Lokal geaendert/);
  assert.equal(hubspot.getLinkByPage(page.id).conflict_state, null);
});

test('hubspot-push: Post drueben geloescht → Link weg, HUBSPOT_REMOTE_GONE, kein stiller Neuanlage-Post', async () => {
  const BOOK_ID = 76;
  const { page, postId, contentStore } = await pushedPage(BOOK_ID);
  mock.deletePost(postId);
  await contentStore.savePage(page.id, { html: '<p>Neu</p>' }, null);

  const job = await pushJob(BOOK_ID, [page.id]);
  assert.equal(job.status, 'error');
  assert.match(String(job.error || ''), /HUBSPOT_REMOTE_GONE/);
  assert.equal(hubspot.getLinkByPage(page.id), null);
  assert.equal(mock.state.created.length, 1, 'kein zweiter Post ohne erneuten Push');

  // Der naechste Push legt bewusst einen neuen Entwurf an.
  const again = await pushJob(BOOK_ID, [page.id]);
  assert.equal(again.status, 'done');
  assert.equal(again.result.createdRemote, 1);
  assert.equal(mock.state.created.length, 2);
});

test('hubspot-reconcile: zieht Status/URL nach, entfernt geloeschte Posts', async () => {
  const BOOK_ID = 77;
  const { page, postId, contentStore } = await pushedPage(BOOK_ID);
  const other = await contentStore.createPage({ book_id: BOOK_ID, name: 'Zweiter', html: '<p>z</p>' }, null);
  assert.equal((await pushJob(BOOK_ID, [other.id])).status, 'done');
  const otherPost = hubspot.getLinkByPage(other.id).hubspot_post_id;

  mock.publish(postId);
  mock.deletePost(otherPost);

  const jobId = ctx.shared.createJob('hubspot-reconcile', BOOK_ID, 'tester@test.dev', 'job.label.hubspotReconcile');
  ctx.shared.enqueueJob(jobId, () => hubspotSync.runHubspotReconcileJob(jobId, BOOK_ID, 'tester@test.dev'));
  const job = await waitForJob(ctx.shared, jobId, { timeoutMs: 4000 });
  assert.equal(job.status, 'done', `got ${job.status}: ${job.error || ''}`);
  assert.equal(job.result.removed, 1);

  const link = hubspot.getLinkByPage(page.id);
  assert.equal(link.hubspot_state, 'PUBLISHED');
  assert.equal(link.hubspot_url, `https://blog.example.com/p/${postId}`);
  assert.equal(hubspot.getLinkByPage(other.id), null);
});

test('hubspot-push: Bilder gehen in den File-Manager, Tabelle bleibt Tabelle', async () => {
  const BOOK_ID = 78;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  await pushedPage(BOOK_ID,
    `<figure><img src="data:image/png;base64,${png}" alt="Bild"><figcaption>Cap</figcaption></figure>`
    + '<table><thead><tr><th scope="col">A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>');
  assert.equal(mock.state.files.length, 1);
  assert.equal(mock.state.files[0].folderPath, '/schreibwerkstatt');
  const body = mock.state.created[0].postBody;
  assert.match(body, /<figure><img src="https:\/\/f\.hubspotusercontent-eu1\.net\/hubfs\/4242\/[^"]+" alt="Bild"><figcaption>Cap<\/figcaption><\/figure>/);
  assert.match(body, /<table><thead><tr><th scope="col">A<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><\/tr><\/tbody><\/table>/);
});

test('hubspot-push: nicht hochladbares Bild fehlt im Post und kommt als Toast-Warnung zurueck', async () => {
  const BOOK_ID = 80;
  seedBlogBook(BOOK_ID);
  hubspot.upsertConnection({ bookId: BOOK_ID, token: 'pat-x', blogId: '555', authorId: '111' });
  const contentStore = require('../../lib/content-store');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  const page = await contentStore.createPage({
    book_id: BOOK_ID, name: 'Mit Fotos',
    html: `<p>Text</p><figure><img src="data:image/heic;base64,AAAA" alt="iPhone"></figure>`
      + `<figure><img src="data:image/png;base64,${png}" alt="ok"></figure>`,
  }, null);
  const filesBefore = mock.state.files.length;
  const job = await pushJob(BOOK_ID, [page.id]);
  assert.equal(job.status, 'done', `got ${job.status}: ${job.error || ''}`);
  assert.equal(mock.state.files.length - filesBefore, 1, 'nur das PNG geht in den File-Manager');
  assert.equal(job.result.imagesUploaded, 1);
  assert.equal(job.result.imagesDropped, 1);
  assert.deepEqual(job.result.toastWarnings, [
    { key: 'sync.push.imagesDropped', params: { count: 1, pages: 'Mit Fotos' } },
  ]);
  const body = mock.state.created.at(-1).postBody;
  assert.doesNotMatch(body, /iPhone|heic/);
  assert.match(body, /alt="ok"/);
});

test('hubspot-push: ohne verworfene Bilder keine Toast-Warnung', async () => {
  const BOOK_ID = 81;
  seedBlogBook(BOOK_ID);
  hubspot.upsertConnection({ bookId: BOOK_ID, token: 'pat-x', blogId: '555', authorId: '111' });
  const contentStore = require('../../lib/content-store');
  const page = await contentStore.createPage({ book_id: BOOK_ID, name: 'Ohne Bild', html: '<p>Text</p>' }, null);
  const job = await pushJob(BOOK_ID, [page.id]);
  assert.equal(job.status, 'done');
  assert.equal(job.result.imagesDropped, 0);
  assert.deepEqual(job.result.toastWarnings, []);
});

test('hubspot-import: zwei parallele Laeufe legen jeden Post genau einmal an (keine verwaiste Seite)', async () => {
  const BOOK_ID = 79;
  seedBlogBook(BOOK_ID);
  hubspot.upsertConnection({ bookId: BOOK_ID, token: 'pat-x', blogId: '555', authorId: '111' });
  const conn = hubspot.getConnection(BOOK_ID);
  const { createLinkedPageFromHubspotPost } = require('../../lib/sync/providers/hubspot');
  const post = { id: '3001', name: 'Doppelt', publishDate: '2025-05-05T00:00:00Z', postBody: '<p>x</p>', state: 'PUBLISHED' };
  const cache1 = new Map();
  const cache2 = new Map();
  const results = await Promise.all([
    createLinkedPageFromHubspotPost({ conn, bookId: BOOK_ID, post, chapterCache: cache1, userEmail: 'tester@test.dev' }),
    createLinkedPageFromHubspotPost({ conn, bookId: BOOK_ID, post, chapterCache: cache2, userEmail: 'tester@test.dev' }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  const pages = ctx.dbSchema.db.prepare('SELECT page_id FROM pages WHERE book_id = ?').all(BOOK_ID);
  assert.equal(pages.length, 1, 'die Seite des Verlierers ist wieder weg');
});
