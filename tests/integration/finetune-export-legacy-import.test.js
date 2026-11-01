'use strict';
// Migration 0350 übernimmt den Altbestand aus `finetune-exports/` (flaches Set
// neben der DB) in finetune_exports/-_files — nur, wenn Buch und Konto noch
// existieren. Frische DBs nehmen den Squash-Fast-Path, darum ruft der Test
// `up` direkt auf.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'finetune-legacy-'));
process.env.DB_PATH = path.join(DIR, 'app.db');
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
delete process.env.FINETUNE_DIR;

const { db } = require('../../db/connection');
require('../../db/migrations').runMigrations();
const appUsers = require('../../db/app-users');
const migration = require('../../db/migrations/0350-finetune-exports');
const { listFinetuneExports, readFinetuneFile } = require('../../db/finetune-exports');

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('flaches Alt-Set wird übernommen, verwaiste nicht', async () => {
  const email = 'alt@ft.test';
  appUsers.createUser({ email, displayName: 'Alt' });
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (7, ?, ?, ?)').run('B', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  const store = path.join(DIR, 'finetune-exports');
  fs.mkdirSync(store);
  const hash = crypto.createHash('sha1').update(email).digest('hex').slice(0, 16);
  const base = path.join(store, `7-${hash}`);
  fs.writeFileSync(`${base}.train.jsonl`, '{"t":1}\n');
  fs.writeFileSync(`${base}.val.jsonl`, '');
  fs.writeFileSync(`${base}.meta.json`, JSON.stringify({ bookName: 'B', createdAt: '2026-10-01T10:00:00.000Z', fingerprint: 'fp', stats: { total: 1 } }));
  // Buch existiert nicht mehr → wird übergangen.
  fs.writeFileSync(path.join(store, `99-${hash}.meta.json`), JSON.stringify({ createdAt: '2026-10-01T10:00:00.000Z', stats: {} }));

  db.transaction(() => migration.up(db))();

  const list = listFinetuneExports(7, email);
  assert.equal(list.length, 1);
  assert.equal(list[0].createdAt, '2026-10-01T10:00:00.000Z');
  assert.equal(list[0].fingerprint, 'fp');
  assert.equal(String(await readFinetuneFile(list[0].id, 'train')), '{"t":1}\n');
  assert.equal(await readFinetuneFile(list[0].id, 'val'), null, 'leere Datei wird nicht übernommen');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM finetune_exports').get().n, 1);
  assert.ok(fs.existsSync(`${base}.meta.json`), 'Dateien bleiben liegen');
});
