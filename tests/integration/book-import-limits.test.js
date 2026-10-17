'use strict';
// Buch-Anlage + .swbook-Import, die harten Faelle:
//   - Buch + Owner-Grant sind eine Einheit (lib/book-create.js): scheitert der
//     Grant, bleibt KEIN Buch zurueck, und der Aufrufer bekommt einen Fehler.
//   - book.json, das beim Entpacken ueber den Deckel waechst (Zip-Bombe), bricht
//     den Job ab, bevor ein Buch entsteht.
//   - Der Buchname aus dem Bundle unterliegt derselben Laengenregel wie die Karte.
//   - Upload-Ablage: ein offener Upload pro User.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const JSZip = require('jszip');

const { bootstrap } = require('./_helpers/setup');

const OWNER = 'autor@test.dev';
let ctxBoot, shared, bookImport, bookAccess, db, server, baseUrl;

before(async () => {
  ctxBoot = bootstrap();
  shared = ctxBoot.shared;
  bookImport = require('../../routes/jobs/book-import');
  bookAccess = require('../../db/book-access');
  db = require('../../db/connection').db;
  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: OWNER } }; next(); });
  app.use('/content', require('../../routes/content'));
  app.use('/jobs', bookImport.bookImportRouter);
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(() => { server?.close(); ctxBoot.cleanup(); });
beforeEach(() => { ctxBoot.dbSeed.reset(); bookImport.importBuffers.clear(); });

const bookCount = () => db.prepare('SELECT COUNT(*) c FROM books').get().c;

async function bundle({ name = 'Importbuch', padding = '' } = {}) {
  const bookBundle = require('../../lib/book-bundle');
  const manifest = bookBundle.buildManifest({ sourceBookId: 1, exportedAt: '2026-05-30T00:00:00Z', includes: bookBundle.normalizeIncludes(null) });
  const bookJson = bookBundle.buildBookJson({
    book: { name, description: padding },
    settings: { language: 'de', region: 'CH', buchtyp: 'roman' },
    nodes: [{ type: 'page', srcId: 1, name: 'S', html: '<p>Text</p>' }],
  });
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('book.json', JSON.stringify(bookJson));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function runImport(buffer, opts = {}) {
  const jobId = shared.createJob('book-import', 0, OWNER, 'job.label.bookImport', {}, `t:${Math.random()}`);
  bookImport.importBuffers.set(jobId, { buffer, userEmail: OWNER });
  await bookImport.runBookImportJob(jobId, { userEmail: OWNER, ...opts });
  return shared.jobs.get(jobId);
}

test('Kontrolle: gueltiges Bundle wird importiert, Owner-Grant steht', async () => {
  const job = await runImport(await bundle());
  assert.equal(job.status, 'done', job.error || '');
  assert.equal(bookAccess.getBookRole(job.result.bookId, OWNER), 'owner');
});

test('book.json waechst beim Entpacken ueber den Deckel → Job-Fehler, kein Buch', async () => {
  // ~1 MB Nullen-artiger Text komprimiert auf wenige KB.
  const buffer = await bundle({ padding: 'a'.repeat(1024 * 1024) });
  assert.ok(buffer.length < 64 * 1024, 'Testbundle muss klein komprimieren');
  const before = bookCount();
  const job = await runImport(buffer, {
    zipLimits: { maxEntries: 10, maxEntryBytes: 256 * 1024, maxTotalBytes: 512 * 1024 },
  });
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.archiveTooLarge');
  assert.equal(bookCount(), before);
});

test('Buchname ueber BOOK_NAME_MAX → Job-Fehler, kein Buch', async () => {
  const { BOOK_NAME_MAX } = require('../../lib/book-create');
  const before = bookCount();
  const job = await runImport(await bundle({ name: 'x'.repeat(BOOK_NAME_MAX + 1) }));
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'job.error.bookNameInvalid');
  assert.equal(bookCount(), before);
});

test('Owner-Grant scheitert → Import bricht ab, Buch wird zurueckgenommen', async () => {
  const orig = bookAccess.grantAccess;
  bookAccess.grantAccess = () => { throw new Error('SQLITE_BUSY'); };
  const before = bookCount();
  try {
    const job = await runImport(await bundle());
    assert.equal(job.status, 'error');
    assert.equal(job.error, 'job.error.bookCreateFailed');
  } finally {
    bookAccess.grantAccess = orig;
  }
  assert.equal(bookCount(), before);
});

test('POST /content/books: Owner-Grant scheitert → 500 CREATE_FAILED, kein Buch', async () => {
  const orig = bookAccess.grantAccess;
  bookAccess.grantAccess = () => { throw new Error('SQLITE_BUSY'); };
  const before = bookCount();
  try {
    const res = await fetch(`${baseUrl}/content/books`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Neu' }),
    });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error_code, 'CREATE_FAILED');
  } finally {
    bookAccess.grantAccess = orig;
  }
  assert.equal(bookCount(), before);

  const ok = await fetch(`${baseUrl}/content/books`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Neu' }),
  });
  assert.equal(ok.status, 200);
  const created = await ok.json();
  assert.equal(created.role, 'owner');
  assert.equal(bookAccess.getBookRole(created.id, OWNER), 'owner');
  assert.equal(db.prepare('SELECT owner_email FROM books WHERE book_id = ?').get(created.id).owner_email, OWNER);
});

test('POST /jobs/book-import: zweiter offener Upload desselben Users → 429 IMPORT_PENDING', async () => {
  bookImport.importBuffers.put('pending-job', { buffer: Buffer.alloc(10), userEmail: OWNER });
  const res = await fetch(`${baseUrl}/jobs/book-import`, {
    method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: await bundle({ name: 'Anderes' }),
  });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error_code, 'IMPORT_PENDING');
});
