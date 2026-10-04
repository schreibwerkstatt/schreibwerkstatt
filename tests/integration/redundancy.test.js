'use strict';
// Integration: Redundanz-Radar (routes/jobs/redundancy.js + routes/redundancy.js).
//
// Was die Unit-Tests nicht sehen: dass der Job seine Seiten über den Content-Store
// bezieht (Chunks einer in ein anderes Buch verschobenen Seite fallen weg, obwohl
// sie noch die alte book_id tragen), dass „Nachbarseiten ausblenden" an der
// Buchreihenfolge hängt, dass ignorierte Paare schon im Scan herausfallen und
// dass das Ergebnis über GET /redundancy/:book_id wieder abrufbar ist.
// Kein Embedding-Endpunkt: die Vektoren werden von Hand gesetzt.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { bootstrap, waitForJob } = require('./_helpers/setup');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
const ME = 'red-autor@test.dev';
const VIEWER = 'red-viewer@test.dev';
const BOOK = 9401;
const OTHER_BOOK = 9402;
const NOW = '2026-01-01T00:00:00.000Z';
const MODEL = 'test-embed';
const DIM = 3;
const SAME = Float32Array.from([1, 0, 0]);
const ORTHO = Float32Array.from([0, 1, 0]);
const TEXT = 'Ein ausreichend langer Absatz, der über der Mindestlänge des Radars liegt.';

// Seiten in Lesereihenfolge P1..P4 (ein Kapitel), P5 liegt inzwischen im anderen
// Buch, ihre Chunks tragen aber noch BOOK.
const P = { p1: 940101, p2: 940102, p3: 940103, p4: 940104, p5: 940201 };

let ctx; let db; let server; let baseUrl; let job;

test.before(async () => {
  ctx = bootstrap();
  db = require('../../db/schema').db;
  const appSettings = require('../../lib/app-settings');
  appSettings.set('embed.enabled', true);
  appSettings.set('embed.host', 'http://embed.invalid');
  appSettings.set('embed.model', MODEL);
  appSettings.set('embed.dim', DIM);

  const { grantAccess } = require('../../db/book-access');
  for (const u of [ME, VIEWER]) db.prepare('INSERT OR IGNORE INTO app_users (email) VALUES (?)').run(u);
  const insBook = db.prepare('INSERT INTO books (book_id, name, created_at, updated_at, owner_email) VALUES (?, ?, ?, ?, ?)');
  insBook.run(BOOK, 'Buch', NOW, NOW, ME);
  insBook.run(OTHER_BOOK, 'Anderes Buch', NOW, NOW, ME);
  grantAccess(BOOK, ME, 'owner', ME);
  grantAccess(OTHER_BOOK, ME, 'owner', ME);
  grantAccess(BOOK, VIEWER, 'viewer', ME);

  const insChap = db.prepare('INSERT INTO chapters (chapter_id, book_id, chapter_name, position, updated_at) VALUES (?, ?, ?, 0, ?)');
  insChap.run(94011, BOOK, 'K1', NOW);
  insChap.run(94021, OTHER_BOOK, 'K2', NOW);
  const insPage = db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, updated_at, body_html)
                              VALUES (?, ?, ?, ?, ?, ?, '<p>x</p>')`);
  insPage.run(P.p1, BOOK, 'P1', 94011, 0, NOW);
  insPage.run(P.p2, BOOK, 'P2', 94011, 1, NOW);
  insPage.run(P.p3, BOOK, 'P3', 94011, 2, NOW);
  insPage.run(P.p4, BOOK, 'P4', 94011, 3, NOW);
  insPage.run(P.p5, OTHER_BOOK, 'P5', 94021, 0, NOW);

  const sc = require('../../db/semantic-chunks');
  const row = (vector) => [{ chunk_ix: 0, content_hash: 'h', vector, text: TEXT }];
  sc.replaceEntity('page', P.p1, BOOK, MODEL, DIM, row(SAME));
  sc.replaceEntity('page', P.p2, BOOK, MODEL, DIM, row(SAME));
  sc.replaceEntity('page', P.p3, BOOK, MODEL, DIM, row(ORTHO));
  sc.replaceEntity('page', P.p4, BOOK, MODEL, DIM, row(SAME));
  sc.replaceEntity('page', P.p5, BOOK, MODEL, DIM, row(SAME)); // verschoben, Chunk noch unter BOOK
  sc.markIndexed(BOOK, MODEL);

  job = require('../../routes/jobs/redundancy');

  const app = express();
  app.use((req, _res, next) => { req.session = { user: { email: req.headers['x-test-user'] || ME } }; next(); });
  app.use('/redundancy', require('../../routes/redundancy'));
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => { if (server) server.close(); ctx.cleanup(); });

async function runScan(opts) {
  const jobId = ctx.shared.createJob('redundancy', BOOK, ME, 'job.label.redundancy');
  ctx.shared.enqueueJob(jobId, () => job.runRedundancyJob(jobId, BOOK, { threshold: 0.9, skipAdjacent: true, ...opts }, ME));
  const done = await waitForJob(ctx.shared, jobId, { timeoutMs: 10000 });
  assert.equal(done.status, 'done', done.error || '');
  return done.result;
}
const keys = (result) => result.pairs.map(p => `${p.a_id}:${p.b_id}`).sort();

async function call(method, path, body, user = ME) {
  const r = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'x-test-user': user, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

test('verschobene Seite fällt weg, Nachbarseiten werden ausgeblendet', async () => {
  const result = await runScan({ skipAdjacent: true });
  assert.deepEqual(keys(result), [`${P.p1}:${P.p4}`, `${P.p2}:${P.p4}`]);
  assert.equal(result.comparedChunks, 4, 'P5 nimmt nicht am Vergleich teil');
  assert.equal(result.skipAdjacent, true);
  assert.ok(result.indexedAt, 'Index-Stand im Ergebnis');
  assert.equal(result.pairs[0].a_text, TEXT);
});

test('ohne Nachbar-Filter erscheint das direkt benachbarte Paar', async () => {
  const result = await runScan({ skipAdjacent: false });
  assert.ok(keys(result).includes(`${P.p1}:${P.p2}`));
  assert.ok(!keys(result).some(k => k.includes(String(P.p5))));
});

test('GET liefert den letzten Lauf; ignoriertes Paar fehlt im nächsten Scan', async () => {
  await runScan({ skipAdjacent: true });
  const last = await call('GET', `/redundancy/${BOOK}`);
  assert.equal(last.status, 200);
  assert.equal(last.json.result.threshold, 0.9);
  assert.equal(last.json.dismissedCount, 0);

  const dis = await call('POST', `/redundancy/${BOOK}/dismissals`, { kind: 'page', a_id: P.p4, b_id: P.p1 });
  assert.equal(dis.status, 200);
  assert.equal(dis.json.dismissedCount, 1);
  const result = await runScan({ skipAdjacent: true });
  assert.deepEqual(keys(result), [`${P.p2}:${P.p4}`]);

  const undo = await call('DELETE', `/redundancy/${BOOK}/dismissals/page/${P.p1}/${P.p4}`);
  assert.equal(undo.json.dismissedCount, 0);
  assert.deepEqual(keys(await runScan({ skipAdjacent: true })), [`${P.p1}:${P.p4}`, `${P.p2}:${P.p4}`]);
});

test('Paar mit Seite aus fremdem Buch → 400; Viewer → 403', async () => {
  const bad = await call('POST', `/redundancy/${BOOK}/dismissals`, { kind: 'page', a_id: P.p1, b_id: P.p5 });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error_code, 'INVALID_PAIR');
  const viewer = await call('GET', `/redundancy/${BOOK}`, null, VIEWER);
  assert.equal(viewer.status, 403);
});
