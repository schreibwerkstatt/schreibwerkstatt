'use strict';
// Finetune-Export-Verlauf über HTTP: Liste (neuestes zuerst, `stale` je Set),
// Download einer Datei per `?id=`, alle Dateien als ZIP, Löschen eines Sets.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DB_PATH = path.join(os.tmpdir(), `finetune-history-${process.pid}-${Date.now()}.db`);
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const express = require('express');
const JSZip = require('jszip');
const { db } = require('../../db/connection');
require('../../db/migrations').runMigrations();
const appUsers = require('../../db/app-users');
const bookAccess = require('../../db/book-access');
const { saveFinetuneExport, KEEP_EXPORTS } = require('../../db/finetune-exports');

const OWNER = 'owner@ft.test';
const BOOK = 8901;
const NOW = '2026-01-01T00:00:00.000Z';
let server;
let baseUrl;

const get = (p, init) => fetch(`${baseUrl}${p}`, init);

test.before(async () => {
  appUsers.createUser({ email: OWNER, displayName: 'Olga' });
  db.prepare('INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(BOOK, 'Buch', NOW, NOW);
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, position, updated_at, body_html)
              VALUES (?, ?, ?, 0, ?, ?)`).run(89011, BOOK, 'Abschnitt', NOW, '<p>Text</p>');
  bookAccess.grantAccess(BOOK, OWNER, 'owner', OWNER);
  const stats = (n) => ({ total: n, train: n, val: 0, allBytes: 0, evalBytes: 0, fileStem: `buch-p-${n}` });
  await saveFinetuneExport(BOOK, OWNER, { createdAt: '2026-10-01T10:00:00.000Z', fingerprint: 'alt', stats: stats(1), files: { train: '{"alt":1}\n' } });
  await saveFinetuneExport(BOOK, OWNER, { createdAt: '2026-10-02T10:00:00.000Z', fingerprint: 'alt', stats: stats(2), files: { train: '{"neu":1}\n', val: '' } });
  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: OWNER } }; next(); });
  app.use('/jobs', require('../../routes/jobs/finetune-export').finetuneExportRouter);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => {
  server?.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(process.env.DB_PATH + ext, { force: true });
});

test('Liste, Einzel-Download, ZIP, Löschen', async () => {
  let r = await get(`/jobs/finetune-export/list?book_id=${BOOK}`);
  assert.equal(r.status, 200);
  const { exports } = await r.json();
  assert.deepEqual(exports.map(e => e.stats.total), [2, 1], 'neuestes zuerst');
  assert.ok(exports.every(e => e.stale), 'Fingerabdruck passt nicht zum Buch → veraltet');
  const [neu, alt] = exports;

  r = await get(`/jobs/finetune-export/train.jsonl?book_id=${BOOK}&id=${alt.id}`);
  assert.equal(await r.text(), '{"alt":1}\n');
  r = await get(`/jobs/finetune-export/train.jsonl?book_id=${BOOK}`);
  assert.equal(await r.text(), '{"neu":1}\n', 'ohne id → neuestes');
  r = await get(`/jobs/finetune-export/train.jsonl?book_id=${BOOK}&id=..%2F..`);
  assert.equal(r.status, 400);
  r = await get(`/jobs/finetune-export/val.jsonl?book_id=${BOOK}&id=${neu.id}`);
  assert.equal(r.status, 404, 'leere Art wird nicht gespeichert');

  r = await get(`/jobs/finetune-export/export.zip?book_id=${BOOK}&id=${neu.id}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /finetune-all-files-buch-p-2\.zip/);
  const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
  assert.deepEqual(Object.keys(zip.files).sort(), ['finetune-stats-buch-p-2.json', 'finetune-train-buch-p-2.jsonl']);
  assert.equal(await zip.file('finetune-train-buch-p-2.jsonl').async('string'), '{"neu":1}\n');

  r = await get(`/jobs/finetune-export/${neu.id}?book_id=${BOOK}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  r = await get(`/jobs/finetune-export/list?book_id=${BOOK}`);
  assert.deepEqual((await r.json()).exports.map(e => e.id), [alt.id]);
});

test('behält die letzten KEEP_EXPORTS Sets; Buch löschen räumt Sets und Dateien weg', async () => {
  for (let i = 0; i < KEEP_EXPORTS + 2; i++) {
    await saveFinetuneExport(BOOK, OWNER, { createdAt: `2026-11-0${i + 1}T10:00:00.000Z`, fingerprint: 'x', stats: { total: i }, files: { train: 'x\n' } });
  }
  const r = await get(`/jobs/finetune-export/list?book_id=${BOOK}`);
  const { exports } = await r.json();
  assert.equal(exports.length, KEEP_EXPORTS);
  assert.equal(exports[0].stats.total, KEEP_EXPORTS + 1);
  db.prepare('DELETE FROM books WHERE book_id = ?').run(BOOK);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM finetune_exports').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM finetune_export_files').get().n, 0);
});
