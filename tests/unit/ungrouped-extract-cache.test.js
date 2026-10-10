'use strict';
// Seiten ohne Kapitel ('__ungrouped__') werden im Multi-Pass gecacht wie jedes Kapitel —
// vorher fiel der Key durch _parseChapterKey (numerische Kapitel-id verlangt), Laden und
// Speichern liefen still ins Leere, und die Gruppe wurde bei jedem Lauf neu extrahiert.
const test = require('node:test');
const assert = require('node:assert/strict');
const { useTmpDb } = require('./_helpers/tmp-db');
useTmpDb('ungrouped-extract-cache');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
const { db } = require('../../db/connection');
require('../../db/migrations').runMigrations();
const { loadChapterExtractCache, saveChapterExtractCache, deleteChapterExtractCache } = require('../../db/ai-caches');

const EMAIL = 'u@test.dev';
db.prepare('INSERT OR IGNORE INTO app_users (email, display_name) VALUES (?, ?)').run(EMAIL, 'U');
db.prepare('INSERT OR IGNORE INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)')
  .run(7, 'B', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', EMAIL);

test('__ungrouped__ (+ __subN, :gap) round-trippt und wird mit gelöscht', () => {
  for (const key of ['__ungrouped__', '__ungrouped____sub2', '__ungrouped__:gap']) {
    saveChapterExtractCache(7, EMAIL, key, 'sig1', { figuren: [{ name: key }] }, 'claude');
    assert.deepEqual(loadChapterExtractCache(7, EMAIL, key, 'sig1', 'claude'), { figuren: [{ name: key }] });
    assert.equal(loadChapterExtractCache(7, EMAIL, key, 'sig2', 'claude'), null, 'andere Signatur = MISS');
  }
  assert.ok(deleteChapterExtractCache(7, EMAIL) >= 3);
  assert.equal(loadChapterExtractCache(7, EMAIL, '__ungrouped__', 'sig1', 'claude'), null);
});
