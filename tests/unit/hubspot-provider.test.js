'use strict';
// HubSpot-Adapter (lib/sync/providers/hubspot.js) + Client-Erweiterungen
// (lib/hubspot-client.js) ohne HTTP-Server: Zuruecklesen ohne Push-Zusaetze,
// Block-IDs, Stempel-Rueckfall, Wiederverknuepfen beim Import, Draft-Suche vor
// dem Create, Fehler-Keys des Imports, gehostete Bilder, Status-Felder.

const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('hubspot-provider');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-1234567890abcdef';

const schema = require('../../db/schema');
const contentStore = require('../../lib/content-store');
const hubspot = require('../../db/hubspot');
const headline = require('../../db/headline');
const provider = require('../../lib/sync/providers/hubspot');
const { createHubspotClient, postStatus, _resetRateLimitForTests } = require('../../lib/hubspot-client');

let _bookSeq = 8800;
function newBook() {
  const id = ++_bookSeq;
  schema.upsertBookByName(id, `Hub-Provider-${id}`);
  hubspot.upsertConnection({ bookId: id, token: 'pat-x', blogId: '555', authorId: '111' });
  return { bookId: id, conn: hubspot.getConnection(id) };
}

// ── Fix 1: Zuruecklesen ohne Push-Zusaetze, Block-IDs ─────────────────────────

test('applyRemote: Lead in die Titel-Werkstatt, Verzeichnis raus, Block-IDs bleiben', async () => {
  const { bookId } = newBook();
  const page = await contentStore.createPage({
    book_id: bookId, name: '2026-01-02: Beitrag', html: '<p data-bid="aa11">Erster Absatz.</p><p data-bid="bb22">Alt.</p>',
  }, null);
  headline.setHeadline(page.id, bookId, { lead: 'Alter Lead.' }, null);
  const pageRow = await contentStore.loadPage(page.id);
  const remote = {
    name: 'Beitrag', updated: '2026-02-01T10:00:00.000Z',
    postBody: '<p class="ms-head__lead"><em>Neuer Lead.</em></p><p>Erster Absatz.</p><p>Neu.</p>'
      + '<h2 class="sw-bibliography">Literatur</h2><ul class="sw-bibliography"><li>Kafka</li></ul>',
  };
  const r = await provider.applyRemote({ pageId: page.id, bookId, pageRow, remote, userEmail: null });
  const after = await contentStore.loadPage(page.id);
  const html = after.html || after.body_html;
  assert.doesNotMatch(html, /Literatur|Kafka|Lead/);
  assert.match(html, /<p data-bid="aa11">Erster Absatz\.<\/p>/, 'Block-ID des unveraenderten Absatzes bleibt');
  assert.match(html, /Neu\./);
  assert.equal(headline.getHeadline(page.id).lead, 'Neuer Lead.');
  assert.ok(r.syncedAt, 'Stempel der eigenen Writes');
});

test('markLinkPulled nimmt den Stempel der eigenen Writes, sonst jetzt', async () => {
  const { bookId, conn } = newBook();
  const page = await contentStore.createPage({ book_id: bookId, name: 'P', html: '<p>x</p>' }, null);
  hubspot.upsertLink({ pageId: page.id, hubId: conn.id, hubspotPostId: 'p-pull' });
  provider.db.markLinkPulled(page.id, { updated: '2026-03-01T00:00:00.000Z' }, '2026-03-02T00:00:00.000Z');
  let link = hubspot.getLinkByPage(page.id);
  assert.equal(link.last_pulled_at, '2026-03-02T00:00:00.000Z');
  assert.equal(link.hubspot_updated_at, '2026-03-01T00:00:00.000Z');
  provider.db.markLinkPulled(page.id, { updated: '2026-03-03T00:00:00.000Z' });
  link = hubspot.getLinkByPage(page.id);
  assert.match(link.last_pulled_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.notEqual(link.last_pulled_at, '2026-03-02T00:00:00.000Z');
});

test('render setzt Marker an Lead und Verzeichnis', async () => {
  const bib = {
    enabled: true, inBlog: true, style: 'apa7', title: 'Literatur', titleHtml: 'Literatur',
    entries: [{ id: 1, num: 1, text: 'K.', html: 'K.' }],
  };
  const body = await provider.render({ appHtml: '<p>Text</p>', bib, hl: { lead: 'L' }, state: {} });
  assert.equal(body, '<p class="ms-head__lead"><em>L</em></p><p>Text</p><h2 class="sw-bibliography">Literatur</h2><ul class="sw-bibliography"><li>K.</li></ul>');
});

// ── Stempel-Rueckfall (Import vor Migration 330) ──────────────────────────────

test('linkStamp: Draft-Stempel, sonst Sync-Punkt', () => {
  assert.equal(provider.linkStamp({ hubspot_updated_at: 'S', last_pushed_at: 'P' }), 'S');
  assert.equal(provider.linkStamp({ hubspot_updated_at: null, last_pushed_at: '2026-05-26T18:32:28.588Z', last_pulled_at: null }),
    '2026-05-26T18:32:28.588Z');
  assert.equal(provider.linkStamp({ hubspot_updated_at: null, last_pushed_at: '2026-05-26T18:32:28.588Z', last_pulled_at: '2026-06-01T00:00:00.000Z' }),
    '2026-06-01T00:00:00.000Z');
  assert.equal(provider.linkStamp({}), null);
});

test('Import setzt hubspot_updated_at am Link', async () => {
  const { bookId, conn } = newBook();
  const post = { id: 'p-stamp', name: 'Gestempelt', publishDate: '2026-04-02T08:00:00Z', updated: '2026-04-03T08:00:00Z', postBody: '<p>x</p>' };
  const created = await provider.createLinkedPageFromHubspotPost({ conn, bookId, post, chapterCache: new Map(), userEmail: null, logger: null });
  assert.ok(created);
  assert.equal(hubspot.getLinkByPage(created.id).hubspot_updated_at, '2026-04-03T08:00:00Z');
});

// ── Fix 4: Wiederverknuepfen statt Dubletten ─────────────────────────────────

test('Import nach Trennen: gleichnamiger Abschnitt wird wieder verknuepft, kein zweiter', async () => {
  const { bookId, conn } = newBook();
  const same = await contentStore.createPage({ book_id: bookId, name: '2026-04-02: Gleich', html: '<p>Gleicher Text.</p>' }, null);
  const diff = await contentStore.createPage({ book_id: bookId, name: '2026-04-05: Geaendert', html: '<p>Lokal bearbeitet.</p>' }, null);
  const relink = await provider.buildRelinkIndex({ conn, bookId });
  const mk = (id, name, day, body) => ({ id, name, publishDate: `${day}T08:00:00Z`, updated: `${day}T09:00:00Z`, postBody: body });

  const a = await provider.createLinkedPageFromHubspotPost({ conn, bookId, post: mk('p1', 'Gleich', '2026-04-02', '<p>Gleicher Text.</p>'), chapterCache: new Map(), relink });
  assert.equal(a.relinked, true);
  assert.equal(a.id, same.id);
  assert.equal(a.conflict, false);
  assert.equal(hubspot.getLinkByPage(same.id).conflict_state, null);

  const b = await provider.createLinkedPageFromHubspotPost({ conn, bookId, post: mk('p2', 'Geaendert', '2026-04-05', '<p>In HubSpot.</p>'), chapterCache: new Map(), relink });
  assert.equal(b.id, diff.id);
  assert.equal(b.conflict, true);
  assert.equal(hubspot.getLinkByPage(diff.id).conflict_state, 'detected');

  // Neuer Post ohne passenden Abschnitt → neue Seite.
  const c = await provider.createLinkedPageFromHubspotPost({ conn, bookId, post: mk('p3', 'Neu seit Juni', '2026-06-10', '<p>n</p>'), chapterCache: new Map(), relink });
  assert.ok(c && !c.relinked);
  const pages = await contentStore.listPages(bookId);
  assert.equal(pages.length, 3);
  // Zweiter Lauf: alles verknuepft → nichts passiert.
  const again = await provider.createLinkedPageFromHubspotPost({ conn, bookId, post: mk('p1', 'Gleich', '2026-04-02', ''), chapterCache: new Map(), relink: await provider.buildRelinkIndex({ conn, bookId }) });
  assert.equal(again, null);
});

test('Wiederverknuepfen per Titel ohne Datum nur bei eindeutigem Treffer', async () => {
  const { bookId, conn } = newBook();
  await contentStore.createPage({ book_id: bookId, name: '2026-01-01: Doppelt', html: '<p>a</p>' }, null);
  await contentStore.createPage({ book_id: bookId, name: '2026-02-01: Doppelt', html: '<p>b</p>' }, null);
  const solo = await contentStore.createPage({ book_id: bookId, name: '2026-11-11: Gepusht', html: '<p>c</p>' }, null);
  const relink = await provider.buildRelinkIndex({ conn, bookId });
  assert.equal(relink.take({ id: 'x', name: 'Doppelt', publishDate: '2026-03-03T00:00:00Z' }), null);
  assert.equal(relink.take({ id: 'y', name: 'Gepusht', publishDate: '2026-11-12T00:00:00Z' }).id, solo.id);
  assert.equal(relink.take({ id: 'z', name: 'Gepusht', publishDate: '2026-11-12T00:00:00Z' }), null, 'einmal vergeben');
});

test('markInitialImportDone behaelt den ersten Lauf, last_import_at rueckt vor', async () => {
  const { bookId, conn } = newBook();
  hubspot.markInitialImportDone(conn.id);
  const first = hubspot.getConnection(bookId).initialImportDoneAt;
  await new Promise(r => setTimeout(r, 5));
  hubspot.markInitialImportDone(conn.id);
  const second = hubspot.getConnection(bookId);
  assert.equal(second.initialImportDoneAt, first);
  assert.ok(second.lastImportAt > first);
});

// ── Fix 8: Import-Fehler als i18n-Key ─────────────────────────────────────────

test('importErrorI18n: bekannte Codes, HTTP-Status, Rest', () => {
  assert.deepEqual(provider.importErrorI18n('HUBSPOT_AUTH_FAILED'), { key: 'hubspot.error.HUBSPOT_AUTH_FAILED', params: null });
  assert.deepEqual(provider.importErrorI18n('HUBSPOT_HTTP_400'), { key: 'hubspot.error.HUBSPOT_HTTP', params: { status: '400' } });
  assert.deepEqual(provider.importErrorI18n('SQLITE_BUSY'), { key: 'hubspot.error.HUBSPOT_IMPORT_FAILED', params: null });
  const de = require('../../public/js/i18n/de.json');
  const en = require('../../public/js/i18n/en.json');
  for (const code of ['HUBSPOT_AUTH_FAILED', 'HUBSPOT_FORBIDDEN', 'HUBSPOT_RATE_LIMIT', 'HUBSPOT_UPSTREAM', 'HUBSPOT_TIMEOUT',
    'HUBSPOT_FETCH_FAILED', 'HUBSPOT_INVALID_JSON', 'HUBSPOT_RESPONSE_TOO_LARGE', 'HUBSPOT_NOT_CONNECTED',
    'HUBSPOT_REQUIRES_BLOG_TYPE', 'HUBSPOT_TOKEN_REQUIRED', 'HUBSPOT_HTTP_500', 'X']) {
    const { key } = provider.importErrorI18n(code);
    assert.ok(de[key] && en[key], `${key} in beiden Locales`);
  }
});

// ── Fix 9: /hubfs/ auf eigener Domain ─────────────────────────────────────────

test('isHubspotHosted: CDN-Hosts und /hubfs/-Pfade auf eigener Domain', () => {
  const h = (u) => provider.isHubspotHosted(new URL(u));
  assert.equal(h('https://12345.fs1.hubspotusercontent-eu1.net/hubfs/12345/a.png'), true);
  assert.equal(h('https://blog.firma.ch/hubfs/bild.png'), true);
  assert.equal(h('https://www.firma.ch/hs-fs/hubfs/bild.png?width=600'), true);
  assert.equal(h('https://example.com/images/hubfs.png'), false);
  assert.equal(h('https://example.com/x/hubfs/a.png'), false);
});

// ── Fix 10 + Client-Vorbereitung ──────────────────────────────────────────────

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    const u = new URL(String(url));
    const handler = routes[`${init.method || 'GET'} ${u.pathname}`];
    const out = handler ? handler(u, init) : { status: 404, json: {} };
    const status = out.status || 200;
    const text = out.json === undefined ? '' : JSON.stringify(out.json);
    return new Response(status === 204 ? null : text, { status, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

test('findPostsByName + findExistingRemote: unverknuepfter Draft gleichen Titels', async () => {
  _resetRateLimitForTests();
  const { conn } = newBook();
  const fetch = fakeFetch({
    'GET /cms/v3/blogs/posts': () => ({ json: { results: [
      { id: 'd1', name: 'Titel', state: 'DRAFT', contentGroupId: '555', blogAuthorId: '111' },
      { id: 'd2', name: 'Titel ', state: 'PUBLISHED', contentGroupId: '555', blogAuthorId: '111' },
      { id: 'd3', name: 'Anders', state: 'DRAFT', contentGroupId: '555', blogAuthorId: '111' },
    ] } }),
  });
  const client = createHubspotClient({ token: 'pat-x', fetch });
  const hits = await client.findPostsByName({ blogId: '555', name: 'Titel', state: 'DRAFT' });
  assert.deepEqual(hits.map(p => p.id), ['d1']);
  const q = new URL(fetch.calls[0].url).searchParams;
  assert.equal(q.get('name'), 'Titel');
  assert.equal(q.get('contentGroupId'), '555');
  const found = await provider.findExistingRemote({ client, conn, title: 'Titel' });
  assert.equal(found.id, 'd1');
  // Schon verknuepft → kein Treffer.
  const page = await contentStore.createPage({ book_id: conn.bookId, name: 'L', html: '<p>x</p>' }, null);
  hubspot.upsertLink({ pageId: page.id, hubId: conn.id, hubspotPostId: 'd1' });
  assert.equal(await provider.findExistingRemote({ client, conn, title: 'Titel' }), null);
  // Fehler → null (Push legt dann wie bisher an).
  const broken = createHubspotClient({ token: 'pat-x', fetch: async () => new Response('', { status: 400 }) });
  assert.equal(await provider.findExistingRemote({ client: broken, conn, title: 'Titel' }), null);
});

test('publishDraft und schedule treffen die v3-Endpunkte', async () => {
  _resetRateLimitForTests();
  const fetch = fakeFetch({
    'POST /cms/v3/blogs/posts/42/draft/push-live': () => ({ status: 204 }),
    'POST /cms/v3/blogs/posts/schedule': () => ({ status: 204 }),
  });
  const client = createHubspotClient({ token: 'pat-x', fetch });
  assert.equal(await client.publishDraft('42'), null);
  assert.equal(await client.schedule('42', '2026-12-01T08:00:00Z'), null);
  assert.equal(fetch.calls[1].method, 'POST');
  assert.deepEqual(JSON.parse(fetch.calls[1].body), { id: '42', publishDate: '2026-12-01T08:00:00.000Z' });
  await assert.rejects(client.schedule('42', 'kein Datum'), /HUBSPOT_SCHEDULE_INVALID/);
});

test('create/update schicken metaDescription und slug (slug nur beim Anlegen)', async () => {
  const sent = [];
  const client = {
    createPost: async (p) => { sent.push(['create', p]); return { id: '1' }; },
    updatePostDraft: async (id, p) => { sent.push(['update', p]); return { id }; },
  };
  const conn = { blogId: '555', authorId: '111' };
  await provider.create({ client, conn, state: {}, title: 'T', body: '<p>b</p>', teaser: '', metaDescription: ' Meta ', slug: 'mein-post' });
  await provider.update({ client, link: { hubspot_post_id: '1' }, title: 'T', body: '<p>b</p>', teaser: 'A & B', metaDescription: '', slug: 'ignoriert' });
  assert.equal(sent[0][1].metaDescription, 'Meta');
  assert.equal(sent[0][1].slug, 'mein-post');
  assert.equal(sent[1][1].metaDescription, undefined, 'leeres Feld ueberschreibt nichts');
  assert.equal(sent[1][1].slug, undefined);
  assert.equal(sent[1][1].postSummary, 'A &amp; B');
});

test('postStatus liest state/currentState/publishDate/url', () => {
  assert.deepEqual(postStatus({ currentState: 'SCHEDULED', publishDate: '2026-12-01T08:00:00Z', absoluteUrl: 'https://b/x' }),
    { state: 'SCHEDULED', currentState: 'SCHEDULED', publishDate: '2026-12-01T08:00:00Z', url: 'https://b/x' });
  assert.deepEqual(postStatus({ state: 'DRAFT', currentState: 'DRAFT', url: 'https://b/y' }),
    { state: 'DRAFT', currentState: 'DRAFT', publishDate: null, url: 'https://b/y' });
  assert.deepEqual(postStatus(null), { state: null, currentState: null, publishDate: null, url: null });
});
