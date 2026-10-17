// materializeOps (Fassungs-Restore / .swbook-Import) mit replace:true: scheitert
// das Update einer BESTEHENDEN Seite bzw. eines Kapitels, bleibt die Zeile
// stehen (alter Stand) und zaehlt als `failed` — Pass 3 darf sie nicht als
// „unbekannt" loeschen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('bundle-apply-keep');

require('../../db/migrations');
const { db } = require('../../db/connection');
const contentStore = require('../../lib/content-store');
const { materializeOps } = require('../../lib/bundle-apply');
const { planFromNodes } = require('../../lib/book-bundle');

const now = new Date().toISOString();
let nextBook = 9701;
function seedBook() {
  const id = nextBook++;
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, 'B', now, now);
  return id;
}
const exists = (t, col, id) => !!db.prepare(`SELECT 1 FROM ${t} WHERE ${col} = ?`).get(id);

function withFailing(name, fn) {
  const orig = contentStore[name];
  contentStore[name] = async () => { throw new Error('transient'); };
  return fn().finally(() => { contentStore[name] = orig; });
}

test('savePage-Fehler auf bestehender Seite: Seite bleibt, failed zaehlt', async () => {
  const bookId = seedBook();
  const keep = await contentStore.createPage({ book_id: bookId, name: 'Alt', html: '<p>alt</p>' });
  const { ops } = planFromNodes([{ type: 'page', name: 'Neu', html: '<p>neu</p>', srcId: keep.id }]);
  const res = await withFailing('savePage', () => materializeOps(bookId, ops, null, { replace: true }));
  assert.equal(res.failed, 1);
  assert.equal(res.deleted.pages, 0);
  assert.ok(exists('pages', 'page_id', keep.id), 'Seite nicht geloescht');
  assert.equal(res.pageIdBySrc.get(keep.id), keep.id);
  assert.match(db.prepare('SELECT body_html FROM pages WHERE page_id = ?').get(keep.id).body_html, /alt/);
});

test('updateChapter-Fehler auf bestehendem Kapitel: Kapitel + Kind-Seite bleiben', async () => {
  const bookId = seedBook();
  const ch = await contentStore.createChapter({ book_id: bookId, name: 'Kapitel alt' });
  const pg = await contentStore.createPage({ book_id: bookId, chapter_id: ch.id, name: 'S', html: '<p>s</p>' });
  const { ops } = planFromNodes([{
    type: 'chapter', name: 'Kapitel neu', srcId: ch.id,
    children: [{ type: 'page', name: 'S', html: '<p>s</p>', srcId: pg.id }],
  }]);
  const res = await withFailing('updateChapter', () => materializeOps(bookId, ops, null, { replace: true }));
  assert.equal(res.failed, 1);
  assert.equal(res.deleted.chapters, 0);
  assert.ok(exists('chapters', 'chapter_id', ch.id), 'Kapitel nicht geloescht');
  assert.ok(exists('pages', 'page_id', pg.id));
  assert.equal(db.prepare('SELECT chapter_id FROM pages WHERE page_id = ?').get(pg.id).chapter_id, ch.id);
});

test('ohne Fehler loescht replace weiterhin, was der Ziel-Stand nicht kennt', async () => {
  const bookId = seedBook();
  const keep = await contentStore.createPage({ book_id: bookId, name: 'A', html: '<p>a</p>' });
  const drop = await contentStore.createPage({ book_id: bookId, name: 'B', html: '<p>b</p>' });
  const { ops } = planFromNodes([{ type: 'page', name: 'A', html: '<p>a</p>', srcId: keep.id }]);
  const res = await materializeOps(bookId, ops, null, { replace: true });
  assert.equal(res.failed, 0);
  assert.ok(exists('pages', 'page_id', keep.id));
  assert.ok(!exists('pages', 'page_id', drop.id));
});
