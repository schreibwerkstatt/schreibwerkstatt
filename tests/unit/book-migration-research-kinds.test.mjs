// restoreResearch: target_kind kommt aus der Import-Datei. Werte wie
// `constructor`/`toString`/`__proto__` duerfen nicht in den Prototyp laufen
// (SQL mit `undefined`-Spalte → ganzer Restore rollt zurueck), sondern fallen
// wie ein unbekanntes Ziel weg.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('migration-research-kinds');

require('../../db/migrations');
const { db } = require('../../db/connection');
const { restoreResearch } = require('../../db/book-migration-data/research');

const now = new Date().toISOString();
db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(9801, 'B', now, now);
db.prepare('INSERT INTO app_users (email) VALUES (?)').run('a@x.ch');
db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, ?, ?)')
  .run(9811, 9801, 'K', 1, now);

test('Prototyp-Keys als target_kind werden uebersprungen, gueltige Links kommen an', () => {
  const data = {
    items: [{ id: 1, kind: 'note', title: 'T' }],
    links: [
      { item_id: 1, target_kind: 'constructor', chapter_id: 5 },
      { item_id: 1, target_kind: 'toString', chapter_id: 5 },
      { item_id: 1, target_kind: '__proto__', chapter_id: 5 },
      { item_id: 1, target_kind: 'hasOwnProperty', chapter_id: 5 },
      { item_id: 1, target_kind: 'unbekannt', chapter_id: 5 },
      { item_id: 1, target_kind: 'chapter', chapter_id: 5 },
    ],
  };
  const ctx = { pageOf: () => null, chapterOf: (id) => (id === 5 ? 9811 : null), email: 'a@x.ch' };
  const res = restoreResearch(9801, data, ctx);
  assert.equal(res.items, 1);
  assert.equal(res.links, 1);
  assert.equal(res.linksDropped, 5);
  const row = db.prepare('SELECT target_kind, chapter_id FROM research_item_links').get();
  assert.deepEqual({ ...row }, { target_kind: 'chapter', chapter_id: 9811 });
});
