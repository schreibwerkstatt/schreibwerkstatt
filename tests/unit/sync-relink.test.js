'use strict';
// lib/sync/relink.js — Wieder-Anschluss beider Blog-Syncs: Trefferstufen
// (Import-Name, Titel ohne Datum, Titel-Werkstatt), nur eindeutige Treffer,
// jeder Abschnitt einmal, verlinkte Abschnitte beider Anbieter tabu, Konflikt
// bei abweichendem Text, verlorenes UNIQUE-Rennen → null.
const test = require('node:test');
const assert = require('node:assert/strict');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('sync-relink');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-1234567890abcdef';

const schema = require('../../db/schema');
const contentStore = require('../../lib/content-store');
const blogs = require('../../db/blogs');
const hubspot = require('../../db/hubspot');
const { setHeadline } = require('../../db/headline');
const { buildRelinkIndex, relinkPage, plainText } = require('../../lib/sync/relink');

let nextBook = 9600;
function newBook() {
  const bookId = nextBook++;
  schema.upsertBookByName(bookId, `Relink-${bookId}`);
  return bookId;
}
const page = (bookId, name, html = '<p>x</p>') => contentStore.createPage({ book_id: bookId, name, html }, null);

test('Stufe 1–3: Import-Name, Titel ohne Datum, Titel-Werkstatt', async () => {
  const bookId = newBook();
  const exact = await page(bookId, '2026-04-01: Exakt');
  const rest = await page(bookId, '2025-01-01: Nur Titel');
  const werk = await page(bookId, 'Arbeitsname');
  setHeadline(werk.id, bookId, { titel: 'Schlagzeile' }, null);
  const idx = await buildRelinkIndex({ bookId });
  assert.equal(idx.take({ title: 'Exakt', day: '2026-04-01' }).id, exact.id);
  assert.equal(idx.take({ title: 'Nur Titel', day: '2026-04-01' }).id, rest.id);
  assert.equal(idx.take({ title: 'Schlagzeile', day: '2026-04-01' }).id, werk.id);
  assert.equal(idx.take({ title: 'Unbekannt', day: '2026-04-01' }), null);
});

test('Nur eindeutige Treffer, jeder Abschnitt hoechstens einmal', async () => {
  const bookId = newBook();
  await page(bookId, '2026-01-01: Doppelt');
  await page(bookId, '2026-02-01: Doppelt');
  const a = await page(bookId, 'A');
  const b = await page(bookId, 'B');
  setHeadline(a.id, bookId, { titel: 'Gleiche Schlagzeile' }, null);
  setHeadline(b.id, bookId, { titel: 'Gleiche Schlagzeile' }, null);
  const solo = await page(bookId, '2026-03-03: Solo');
  const idx = await buildRelinkIndex({ bookId });
  assert.equal(idx.take({ title: 'Doppelt', day: '2026-05-05' }), null, 'Titel mehrdeutig');
  assert.equal(idx.take({ title: 'Gleiche Schlagzeile', day: '2026-05-05' }), null, 'Werkstatt-Titel mehrdeutig');
  assert.equal(idx.take({ title: 'Solo', day: '2026-03-03' }).id, solo.id);
  assert.equal(idx.take({ title: 'Solo', day: '2026-03-03' }), null, 'einmal vergeben');
});

test('Verlinkte Abschnitte beider Anbieter sind keine Kandidaten', async () => {
  const bookId = newBook();
  const wpLinked = await page(bookId, '2026-04-01: WP');
  const hsLinked = await page(bookId, '2026-04-01: HS');
  const wc = blogs.upsertConnection({ bookId, baseUrl: 'https://a.example', username: 'u', password: 'p' });
  blogs.upsertLink({ pageId: wpLinked.id, blogId: wc.id, wpPostId: 1, wpModifiedAt: '2026-04-01T00:00:00' });
  const hc = hubspot.upsertConnection({ bookId, token: 't', blogId: '1', authorId: 'a', portalId: '42' });
  hubspot.upsertLink({ pageId: hsLinked.id, hubId: hc.id, hubspotPostId: '9' });
  const idx = await buildRelinkIndex({ bookId });
  assert.equal(idx.take({ title: 'WP', day: '2026-04-01' }), null);
  assert.equal(idx.take({ title: 'HS', day: '2026-04-01' }), null);
});

test('relinkPage: gleicher Text → kein Konflikt, abweichender → Konflikt, UNIQUE-Rennen → null', async () => {
  const bookId = newBook();
  const p = await page(bookId, 'P', '<p>Hallo <strong>Welt</strong>.</p>');
  const writes = [];
  const writeLink = (w) => { writes.push(w.conflict); };
  assert.equal((await relinkPage({ page: p, remoteAppHtml: '<p>Hallo Welt.</p>', writeLink })).conflict, false);
  assert.equal((await relinkPage({ page: p, remoteAppHtml: '<p>Anders.</p>', writeLink })).conflict, true);
  assert.deepEqual(writes, [false, true]);
  const lost = await relinkPage({ page: p, remoteAppHtml: '', writeLink: () => { throw new Error('UNIQUE constraint failed'); } });
  assert.equal(lost, null);
  await assert.rejects(relinkPage({ page: p, remoteAppHtml: '', writeLink: () => { throw new Error('boom'); } }), /boom/);
  assert.equal(plainText('<p>a</p>\n<p>b&nbsp;c</p>'), 'a b c');
});
