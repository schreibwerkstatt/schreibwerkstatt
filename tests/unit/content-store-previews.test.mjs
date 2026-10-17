// contentStore.setPagePreviews: Vorschautext-Cache ist kein Inhalt —
// updated_at/local_updated_at bleiben stehen, keine Revision entsteht.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('content-store-previews');

require('../../db/migrations');
const { db } = require('../../db/connection');
const contentStore = require('../../lib/content-store');

const now = new Date().toISOString();
db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(9701, 'B', now, now);

const row = (id) => db.prepare('SELECT preview_text, updated_at, local_updated_at FROM pages WHERE page_id = ?').get(id);
const revCount = (id) => db.prepare('SELECT COUNT(*) AS n FROM page_revisions WHERE page_id = ?').get(id).n;

test('setPagePreviews schreibt preview_text ohne Zeitstempel/Revision', async () => {
  const a = await contentStore.createPage({ book_id: 9701, name: 'A', html: '<p>eins</p>' });
  const b = await contentStore.createPage({ book_id: 9701, name: 'B', html: '<p>zwei</p>' });
  const before = [row(a.id), row(b.id)];
  const revs = [revCount(a.id), revCount(b.id)];

  const n = contentStore.setPagePreviews([
    { page_id: a.id, preview_text: 'Vorschau A' },
    { page_id: b.id, preview_text: null },
    { page_id: 'x', preview_text: 'ungueltig' },
  ]);
  assert.equal(n, 2);
  const after = [row(a.id), row(b.id)];
  assert.equal(after[0].preview_text, 'Vorschau A');
  assert.equal(after[1].preview_text, null);
  for (let i = 0; i < 2; i++) {
    assert.equal(after[i].updated_at, before[i].updated_at);
    assert.equal(after[i].local_updated_at, before[i].local_updated_at);
  }
  assert.deepEqual([revCount(a.id), revCount(b.id)], revs);
});

test('setPagePreviews: leere Liste / null ist No-op', () => {
  assert.equal(contentStore.setPagePreviews([]), 0);
  assert.equal(contentStore.setPagePreviews(null), 0);
});

test('setPagePreviews: eine Transaktion — Fehler rollt alles zurueck', async () => {
  const c = await contentStore.createPage({ book_id: 9701, name: 'C', html: '<p>drei</p>' });
  contentStore.setPagePreviews([{ page_id: c.id, preview_text: 'alt' }]);
  // Ein nicht bindbarer Wert (Objekt) wirft mitten im Batch.
  assert.throws(() => contentStore.setPagePreviews([
    { page_id: c.id, preview_text: 'neu' },
    { page_id: c.id, preview_text: { kaputt: true } },
  ]));
  assert.equal(row(c.id).preview_text, 'alt');
});

test('routes/sync.js schreibt preview_text nur ueber die Facade', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../routes/sync.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /UPDATE\s+pages\s+SET\s+preview_text/i);
  assert.match(src, /contentStore\.setPagePreviews\(/);
});
