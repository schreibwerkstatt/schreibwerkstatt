'use strict';
// Integration: Admin-Backup über HTTP (routes/admin-backup.js + lib/db-backup.js).
//  - Restore-Upload merkt vor (/info meldet die Vormerkung samt Grösse),
//    DELETE /pending verwirft sie wieder, /restart ohne Vormerkung → 409.
//  - Ungültiger Upload hinterlässt keine Vormerkung.
//  - Download zweistufig: POST /snapshot liefert ein Einmal-Token, GET
//    /download?token= streamt gzip, ein zweites Abholen → 410; fremder Admin
//    bekommt den Snapshot nicht.
//  - /info trägt eine Boot-ID (Neustart-Erkennung der Karte).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const zlib = require('zlib');
const express = require('express');

const { bootstrap } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const ADMIN = 'admin@test.dev';
const ADMIN2 = 'admin2@test.dev';

let ctx; let db; let dbBackup; let server; let baseUrl;

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  dbBackup = require('../../lib/db-backup');
  const NOW = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO app_users (email, display_name, status, global_role, created_at)
                          VALUES (?, 'Admin', 'active', 'admin', ?)`);
  ins.run(ADMIN, NOW);
  ins.run(ADMIN2, NOW);

  const app = express();
  app.use((req, _res, next) => {
    const u = req.get('x-user');
    req.session = u ? { user: { email: u, role: 'admin' } } : {};
    next();
  });
  app.use('/admin/backup', require('../../routes/admin-backup'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => {
  try { dbBackup.discardPendingRestore(); } catch { /* ignore */ }
  if (server) server.close();
  ctx.cleanup();
});

const req = (method, path, { user = ADMIN, body, type } = {}) => fetch(baseUrl + path, {
  method,
  headers: { 'x-user': user, ...(type ? { 'Content-Type': type } : {}) },
  body,
});

const info = async () => (await req('GET', '/admin/backup/info')).json();

test('/info meldet Boot-ID und keine Vormerkung', async () => {
  const i = await info();
  assert.equal(typeof i.bootId, 'string');
  assert.ok(i.bootId.length > 0);
  assert.equal(i.hasPending, false);
  assert.equal(i.pending, null);
});

test('Upload merkt vor, DELETE /pending verwirft die Vormerkung', async () => {
  const snap = dbBackup.createSnapshotFile();
  let raw;
  try { raw = fs.readFileSync(snap); } finally { fs.rmSync(snap, { force: true }); }
  const res = await req('POST', '/admin/backup/restore', {
    body: zlib.gzipSync(raw), type: 'application/octet-stream',
  });
  assert.equal(res.status, 200);
  const staged = await res.json();
  assert.equal(staged.ok, true);
  assert.equal(staged.bytes, raw.length);

  let i = await info();
  assert.equal(i.hasPending, true);
  assert.equal(i.pending.bytes, raw.length);
  assert.ok(!Number.isNaN(Date.parse(i.pending.stagedAt)));

  const del = await req('DELETE', '/admin/backup/pending');
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true, discarded: true });

  i = await info();
  assert.equal(i.hasPending, false);
  assert.equal(dbBackup.hasPendingRestore(), false);

  // Zweites Verwerfen ist harmlos, meldet aber, dass nichts mehr lag.
  const again = await (await req('DELETE', '/admin/backup/pending')).json();
  assert.equal(again.discarded, false);

  // Ohne Vormerkung startet nichts neu.
  const restart = await req('POST', '/admin/backup/restart');
  assert.equal(restart.status, 409);
  assert.equal((await restart.json()).error_code, 'NO_PENDING_RESTORE');
});

test('Ungültiger Upload hinterlässt keine Vormerkung', async () => {
  const res = await req('POST', '/admin/backup/restore', {
    body: Buffer.from('kein sqlite, nur text'), type: 'application/octet-stream',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error_code, 'NOT_SQLITE');
  assert.equal((await info()).hasPending, false);
});

test('Download zweistufig: Token einmal gültig, nur für denselben Admin', async () => {
  const prep = await req('POST', '/admin/backup/snapshot');
  assert.equal(prep.status, 200);
  const { token, bytes } = await prep.json();
  assert.equal(typeof token, 'string');
  assert.ok(bytes > 0);

  const foreign = await req('GET', `/admin/backup/download?token=${encodeURIComponent(token)}`, { user: ADMIN2 });
  assert.equal(foreign.status, 410);

  const dl = await req('GET', `/admin/backup/download?token=${encodeURIComponent(token)}`);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/gzip');
  const body = zlib.gunzipSync(Buffer.from(await dl.arrayBuffer()));
  assert.equal(body.toString('latin1', 0, 15), 'SQLite format 3');

  const second = await req('GET', `/admin/backup/download?token=${encodeURIComponent(token)}`);
  assert.equal(second.status, 410);
  assert.equal((await second.json()).error_code, 'SNAPSHOT_EXPIRED');
});

test('Ohne Admin-Session kein Zugriff', async () => {
  const res = await fetch(baseUrl + '/admin/backup/pending', { method: 'DELETE' });
  assert.equal(res.status, 401);
});
