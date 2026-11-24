'use strict';
// Integration: Bilder und Push-Sperre im HubSpot-Sync gegen Mock-HubSpot.
//   - Import spiegelt Bilder als Abschnittsbilder; ein Push setzt die
//     Original-Adresse wieder ein (Bild-Cache), ohne erneuten Upload.
//   - Push-Sperre: CTA/Formular/Modul im Entwurf oder ein im Abschnitt
//     fehlendes Bild → HUBSPOT_UNSUPPORTED_BLOCKS, kein PATCH.
//   - Bilder-Nachzug (Job hubspot-images): unveraenderte Abschnitte bekommen
//     ihre Bilder, bearbeitete bleiben unangetastet und gesperrt.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-1234567890abcdef';
// Bild-Adressen im Test zeigen auf einen erfundenen Host; der SSRF-Guard soll
// nur die DNS-Aufloesung auslassen, nicht seine uebrigen Pruefungen.
process.env.SSRF_SKIP_DNS_CHECK = '1';

const sharp = require('sharp');
const { bootstrap, waitForJob } = require('./_helpers/setup');
const { makeMock } = require('./_helpers/mock-hubspot');

const IMG_HOST = 'https://cdn.hubspotusercontent-eu1.net';
const IMG_URL = `${IMG_HOST}/hubfs/4242/Bilder/team.png`;

let ctx;
let mock;
let hubspot;
let hubspotSync;
let png;
let imageFetches;
let restoreImageFetch;

test.before(async () => {
  ctx = bootstrap();
  hubspot = require('../../db/hubspot');
  hubspotSync = require('../../routes/jobs/hubspot-sync');
  png = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#c33' } }).png().toBuffer();
});
test.after(() => { ctx.cleanup(); });

test.beforeEach(() => {
  ctx.dbSeed.reset();
  mock = makeMock();
  // Bild-Server vor den HubSpot-Mock haengen (der reicht fremde URLs durch).
  imageFetches = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = typeof url === 'string' ? url : url.toString();
    if (u.startsWith(IMG_HOST)) {
      imageFetches.push(u);
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    return inner(url, opts);
  };
  restoreImageFetch = () => { globalThis.fetch = inner; };
});
test.afterEach(() => { restoreImageFetch(); mock.restore(); });

function seedBlogBook(bookId) {
  ctx.dbSeed.setBook({ books: [{ id: bookId, name: `Img-Book-${bookId}` }], chapters: [], pages: [], pageBodies: {} });
  ctx.dbSchema.saveBookSettings(bookId, { language: 'de', region: 'CH', buchtyp: 'blog', buch_kontext: '', erzaehlperspektive: null, erzaehlzeit: null, is_finished: 0, allow_lektor_book_chat: 0, daily_goal_chars: 1500 });
  hubspot.upsertConnection({ bookId, token: 'pat-x', blogId: '555', authorId: '111' });
}

async function runJob(type, bookId, run, ...args) {
  const jobId = ctx.shared.createJob(type, bookId, 'tester@test.dev', `job.label.${type}`);
  ctx.shared.enqueueJob(jobId, () => run(jobId, bookId, 'tester@test.dev', ...args));
  return waitForJob(ctx.shared, jobId, { timeoutMs: 8000 });
}
const importJob = (bookId) => runJob('hubspot-import', bookId, hubspotSync.runHubspotImportJob);
const pushJob = (bookId, pageIds) => runJob('hubspot-push', bookId, hubspotSync.runHubspotPushJob, pageIds);
const imagesJob = (bookId) => runJob('hubspot-images', bookId, hubspotSync.runHubspotImageRepairJob);

function post(id, body, extra = {}) {
  return {
    id, name: `Beitrag ${id}`, publishDate: '2025-05-01T10:00:00.000Z', state: 'PUBLISHED',
    blogAuthorId: '111', updated: '2025-05-02T10:00:00.000Z', postBody: body, ...extra,
  };
}

function pageHtml(pageId) {
  return ctx.dbSchema.db.prepare('SELECT body_html FROM pages WHERE page_id = ?').get(pageId).body_html;
}

test('Import spiegelt Bilder als Abschnittsbild; Re-Push setzt die Original-Adresse ein, ohne Upload', async () => {
  const BOOK = 91;
  seedBlogBook(BOOK);
  mock.state.posts = [post('2001', `<p>Text</p><p><img src="${IMG_URL}?width=600&amp;name=team.png" alt="Team"></p>`)];
  const job = await importJob(BOOK);
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(imageFetches.length, 1);

  const link = hubspot.listLinksForConnection(hubspot.getConnection(BOOK).id)[0];
  const html = pageHtml(link.page_id);
  assert.match(html, /<figure[^>]*><img src="\/content\/page-image\/\d+" alt="Team"><\/figure>/);
  assert.equal(link.locked_blocks, null, 'Bilder sperren nicht, wenn der Abschnitt sie traegt');

  // Lokal bearbeiten, dann pushen: das Bild geht mit seiner HubSpot-Adresse raus.
  const contentStore = require('../../lib/content-store');
  await new Promise(r => setTimeout(r, 20));
  await contentStore.savePage(link.page_id, { html: html.replace('Text', 'Neuer Text') }, null);
  const pushed = await pushJob(BOOK, [link.page_id]);
  assert.equal(pushed.status, 'done', pushed.error || '');
  assert.equal(mock.state.files.length, 0, 'kein erneuter Upload in den File-Manager');
  assert.equal(mock.state.updated.length, 1);
  assert.match(mock.state.updated[0].postBody, /<img src="https:\/\/cdn\.hubspotusercontent-eu1\.net\/hubfs\/4242\/Bilder\/team\.png\?width=600&amp;name=team\.png" alt="Team">/);
  assert.match(mock.state.updated[0].postBody, /Neuer Text/);
});

test('Push-Sperre: CTA/Formular/Modul im Entwurf → HUBSPOT_UNSUPPORTED_BLOCKS, kein PATCH', async () => {
  const BOOK = 92;
  seedBlogBook(BOOK);
  mock.state.posts = [
    post('2101', '<p>Mit CTA</p><span class="hs-cta-wrapper"><a href="https://x.test">Jetzt</a></span>'),
    post('2102', '<p>Mit Modul {% module "teaser" path="@hubspot/rich_text" %}</p>'),
    post('2103', '<p>Schlicht</p>'),
  ];
  assert.equal((await importJob(BOOK)).status, 'done');
  const links = hubspot.listLinksForConnection(hubspot.getConnection(BOOK).id);
  const byPost = Object.fromEntries(links.map(l => [l.hubspot_post_id, l]));
  assert.equal(byPost['2101'].locked_blocks, 'hs-cta', 'Sperre schon beim Import gemerkt');
  assert.equal(byPost['2102'].locked_blocks, 'hs-module');
  assert.equal(byPost['2103'].locked_blocks, null);

  const contentStore = require('../../lib/content-store');
  await new Promise(r => setTimeout(r, 20));
  for (const l of links) await contentStore.savePage(l.page_id, { html: '<p>Lokal geaendert</p>' }, null);
  const job = await pushJob(BOOK, links.map(l => l.page_id));
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(job.result.pushed, 1, 'nur der schlichte Post geht durch');
  const blocked = job.result.errors.filter(e => e.code === 'HUBSPOT_UNSUPPORTED_BLOCKS');
  assert.equal(blocked.length, 2);
  assert.deepEqual(mock.state.updated.map(u => u.id), ['2103']);
});

test('Vor dem Bild-Spiegel importiert: fehlendes Bild sperrt; Nachzug holt es, bearbeitete bleiben gesperrt', async () => {
  const BOOK = 93;
  seedBlogBook(BOOK);
  const conn = hubspot.getConnection(BOOK);
  const contentStore = require('../../lib/content-store');
  // Zwei „alte" Importe: Abschnitt ohne Bild, Entwurf mit Bild.
  const body = `<p>Absatz</p><p><img src="${IMG_URL}" alt="Team"></p>`;
  mock.state.posts = [post('2201', body), post('2202', body)];
  const pages = [];
  for (const id of ['2201', '2202']) {
    const page = await contentStore.createPage({ book_id: BOOK, name: `Alt ${id}`, html: '<p>Absatz</p>' }, null);
    hubspot.upsertLink({
      pageId: page.id, hubId: conn.id, hubspotPostId: id, hubspotState: 'PUBLISHED',
      hubspotUpdatedAt: '2025-05-02T10:00:00.000Z', lastPushedAt: page.updated_at,
    });
    pages.push(page);
  }
  await new Promise(r => setTimeout(r, 20));
  // Der zweite wurde seit dem Import bearbeitet.
  await contentStore.savePage(pages[1].id, { html: '<p>Absatz, ueberarbeitet</p>' }, null);
  await contentStore.savePage(pages[0].id, { html: '<p>Absatz.</p>' }, null);

  // Push: beide gesperrt — ein Push haette das Bild im Entwurf geloescht.
  const blocked = await pushJob(BOOK, pages.map(p => p.id));
  assert.equal(blocked.status, 'error');
  assert.match(String(blocked.error || ''), /HUBSPOT_UNSUPPORTED_BLOCKS/);
  assert.equal(mock.state.updated.length, 0);
  assert.equal(hubspot.getLinkByPage(pages[0].id).locked_blocks, 'image-missing');

  // Lokale Aenderung am ersten zuruecknehmen (Sync-Punkt nachziehen), damit er
  // als unveraendert gilt — so sieht ein alter, nie bearbeiteter Import aus.
  hubspot.upsertLink({
    pageId: pages[0].id, hubId: conn.id, hubspotPostId: '2201',
    lastPushedAt: new Date(Date.now() + 1000).toISOString(),
  });

  const repair = await imagesJob(BOOK);
  assert.equal(repair.status, 'done', repair.error || '');
  assert.equal(repair.result.repaired, 1);
  assert.deepEqual(repair.result.skipped.map(s => s.reason), ['LOCAL_CHANGES']);
  assert.match(pageHtml(pages[0].id), /<figure[^>]*><img src="\/content\/page-image\/\d+" alt="Team">/);
  assert.equal(hubspot.getLinkByPage(pages[0].id).locked_blocks, null);
  assert.equal(hubspot.getLinkByPage(pages[1].id).locked_blocks, 'image-missing');
  assert.doesNotMatch(pageHtml(pages[1].id), /<img/, 'bearbeiteter Abschnitt bleibt unangetastet');

  // Jetzt geht der Push des nachgezogenen Abschnitts durch — mit dem Bild.
  await new Promise(r => setTimeout(r, 20));
  await contentStore.savePage(pages[0].id, { html: pageHtml(pages[0].id).replace('Absatz', 'Absatz neu') }, null);
  const ok = await pushJob(BOOK, [pages[0].id]);
  assert.equal(ok.status, 'done', ok.error || '');
  assert.match(mock.state.updated[0].postBody, /team\.png" alt="Team"/);
  assert.equal(mock.state.files.length, 0);
});
