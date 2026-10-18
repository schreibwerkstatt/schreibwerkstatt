'use strict';
// Zielwechsel einer Blog-Verbindung (WordPress: andere URL, HubSpot: anderer
// Blog oder anderes Portal) verwirft Links und Import-Stand. Sonst traegt ein
// Link die Post-ID des ALTEN Ziels, und der naechste Push ueberschreibt auf dem
// neuen Ziel einen fremden Post mit derselben ID (db/blogs.js, db/hubspot.js
// #upsertConnection).
const test = require('node:test');
const assert = require('node:assert');

const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('sync-target-change');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-1234567890abcdef';

const schema = require('../../db/schema');
const contentStore = require('../../lib/content-store');
const blogs = require('../../db/blogs');
const hubspot = require('../../db/hubspot');

async function bookWithPage(bookId) {
  schema.upsertBookByName(bookId, `Sync-Ziel-${bookId}`);
  return contentStore.createPage({ book_id: bookId, name: 'P', html: '<p>x</p>' }, null);
}

test('WordPress: andere Blog-URL → Links + Import-Stand weg; anderer User → bleibt', async () => {
  const page = await bookWithPage(8801);
  const conn = blogs.upsertConnection({ bookId: 8801, baseUrl: 'https://a.example', username: 'u', password: 'p' });
  assert.equal(conn.targetChanged, false);
  blogs.upsertLink({ pageId: page.id, blogId: conn.id, wpPostId: 5, wpModifiedAt: '2025-01-01T00:00:00' });
  blogs.markInitialImportDone(conn.id);

  const sameSite = blogs.upsertConnection({ bookId: 8801, baseUrl: 'https://a.example', username: 'other', password: 'p2' });
  assert.equal(sameSite.targetChanged, false);
  assert.ok(blogs.getLinkByPage(page.id), 'gleicher Blog, anderer User: Link bleibt');

  const moved = blogs.upsertConnection({ bookId: 8801, baseUrl: 'https://b.example', username: 'u', password: 'p' });
  assert.equal(moved.targetChanged, true);
  assert.equal(blogs.getLinkByPage(page.id), null);
  assert.equal(blogs.getConnection(8801).initialImportDoneAt, null);
});

test('HubSpot: anderer Blog oder anderes Portal → Links + Import-Stand weg; anderer Autor → bleibt', async () => {
  const page = await bookWithPage(8802);
  const conn = hubspot.upsertConnection({ bookId: 8802, token: 't', blogId: '1', authorId: 'a', portalId: '42' });
  const link = () => hubspot.upsertLink({ pageId: page.id, hubId: conn.id, hubspotPostId: '900' });
  link();
  hubspot.markInitialImportDone(conn.id);

  assert.equal(hubspot.upsertConnection({ bookId: 8802, token: 't', blogId: '1', authorId: 'b', portalId: '42' }).targetChanged, false);
  assert.ok(hubspot.getLinkByPage(page.id), 'anderer Autor: Link bleibt');

  assert.equal(hubspot.upsertConnection({ bookId: 8802, token: 't', blogId: '2', authorId: 'b', portalId: '42' }).targetChanged, true);
  assert.equal(hubspot.getLinkByPage(page.id), null);
  assert.equal(hubspot.getConnection(8802).initialImportDoneAt, null);

  link();
  assert.equal(hubspot.upsertConnection({ bookId: 8802, token: 't2', blogId: '2', authorId: 'b', portalId: '77' }).targetChanged, true);
  assert.equal(hubspot.getLinkByPage(page.id), null, 'anderes Portal: Link weg');
});

test('HubSpot-Link: Konfliktstatus, Aufloesung und Push setzen das Sync-Modell wie bei WordPress', async () => {
  const page = await bookWithPage(8803);
  const conn = hubspot.upsertConnection({ bookId: 8803, token: 't', blogId: '1', authorId: 'a' });
  hubspot.upsertLink({ pageId: page.id, hubId: conn.id, hubspotPostId: '901', hubspotUpdatedAt: '2025-01-01T00:00:00Z' });
  hubspot.setConflictState(page.id, 'detected');
  assert.equal(hubspot.getLinkByPage(page.id).conflict_state, 'detected');

  hubspot.markConflictResolvedApp(page.id, '2025-02-01T00:00:00Z');
  let l = hubspot.getLinkByPage(page.id);
  assert.equal(l.conflict_state, 'resolved-app');
  assert.equal(l.hubspot_updated_at, '2025-02-01T00:00:00Z');

  hubspot.upsertLink({ pageId: page.id, hubId: conn.id, hubspotPostId: '901', lastPushedAt: '2025-03-01T00:00:00Z' });
  l = hubspot.getLinkByPage(page.id);
  assert.equal(l.conflict_state, null, 'Push ist ein Sync-Punkt');
  assert.equal(l.hubspot_updated_at, '2025-02-01T00:00:00Z', 'ohne neuen Stempel bleibt der alte');

  hubspot.markLinkPulled(page.id, { remoteUpdatedAt: '2025-04-01T00:00:00Z' });
  l = hubspot.getLinkByPage(page.id);
  assert.match(l.last_pulled_at, /^\d{4}-/);
  assert.equal(l.hubspot_updated_at, '2025-04-01T00:00:00Z');
  assert.throws(() => hubspot.setConflictState(page.id, 'bogus'));
});
